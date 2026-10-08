#!/usr/bin/env bash
# Canada data refresh driver for a scheduled job (every 24 hours).
#
# Decisions, each gated on current state so repeated runs are safe:
#   A. publish: no scrape running and region CSVs newer than the app snapshot
#      -> rebuild, run the pipeline + vitest suites, commit the two tracked
#      data files, push origin main.
#   B. refresh: no scrape running and (CSV set stale, a previous run left
#      regions unfinished (pending/partial/challenged) past the start gap,
#      or --force-refresh)
#      -> start scripts/pull_all_provinces.sh detached in the scraper repo.
#
# ../property-scraper is read-only: its region data, queue state, and regions
# files are read, and pull_all_provinces.sh is launched for decision B.
# Decision B launches the wrapper bare when only unfinished work is pending
# (it resumes each province from its queue state), or with the wrapper-only
# --reopen-all and --prune when the refresh is stale/forced, so `done` regions
# re-scrape and delisted listings are removed.
# Per-province --reopen is never passed directly here (it rejects foreign
# slugs); the wrapper expands --reopen-all into each province's own slugs.
# The wrapper flags passed here (--reopen-all, --prune) must exist in the
# property-scraper checkout first; an older wrapper rejects unknown args.
#
# Usage: scripts/canada_refresh.sh [--dry-run] [--force-refresh]
# Env:   APP_REPO, SCRAPER_REPO, STALE_DAYS (7), MIN_RUN_GAP_HOURS (24)
# Test:  CANADA_REFRESH_FORCE_IDLE=1 forces RUNNING=no; keep it out of schedules.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_REPO="${APP_REPO:-$(cd -- "$SCRIPT_DIR/.." && pwd -P)}"
SCRAPER_REPO="${SCRAPER_REPO:-$APP_REPO/../property-scraper}"
STALE_DAYS="${STALE_DAYS:-7}"
MIN_RUN_GAP_HOURS="${MIN_RUN_GAP_HOURS:-24}"

DRY_RUN=0
FORCE_REFRESH=0

usage() {
  echo "usage: scripts/canada_refresh.sh [--dry-run] [--force-refresh]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --force-refresh) FORCE_REFRESH=1 ;;
    --help|-h) usage; exit 0 ;;
    *) usage; echo "STATUS: failed (unknown argument: $1)"; exit 1 ;;
  esac
  shift
done

preflight_fail() {
  echo "STATUS: failed ($1)"
  exit 1
}

[ -d "$APP_REPO" ] || preflight_fail "app repo not found: $APP_REPO"
[ -d "$SCRAPER_REPO" ] || preflight_fail "scraper repo not found: $SCRAPER_REPO"
[ -x "$SCRAPER_REPO/.venv313/bin/property-ontario" ] || preflight_fail "property-ontario missing or not executable"
[ -f "$SCRAPER_REPO/scripts/pull_all_provinces.sh" ] || preflight_fail "pull_all_provinces.sh not found"
for prov in on ab bc mb nb nl ns nt nu pe qc sk yt; do
  regions_file="$SCRAPER_REPO/regions/$prov.json"
  [ -f "$regions_file" ] || preflight_fail "regions file not found: $regions_file"
done
[ -f "$APP_REPO/data/listings.json" ] || preflight_fail "data/listings.json not found"
for tool in python3 npm git; do
  command -v "$tool" >/dev/null 2>&1 || preflight_fail "$tool not on PATH"
done

mtime() {
  if stat -f %m "$1" >/dev/null 2>&1; then
    stat -f %m "$1"
  else
    stat -c %Y "$1"
  fi
}

NOW="$(date -u +%s)"

# A property process matches; this driver's own cmdline ("bash scripts/
# canada_refresh.sh") cannot. Test-only override documented above.
RUNNING=no
if [ "${CANADA_REFRESH_FORCE_IDLE:-}" != "1" ]; then
  if pgrep -f property_scraper >/dev/null 2>&1 || pgrep -f property-ontario >/dev/null 2>&1; then
    RUNNING=yes
  fi
fi

NEWEST_CSV_EPOCH=0
for csv in "$SCRAPER_REPO"/data/regions/*/listings.csv; do
  [ -f "$csv" ] || continue
  epoch="$(mtime "$csv")"
  if [ "$epoch" -gt "$NEWEST_CSV_EPOCH" ]; then
    NEWEST_CSV_EPOCH="$epoch"
  fi
done
DATA_JSON_EPOCH="$(mtime "$APP_REPO/data/listings.json")"

if [ "$NEWEST_CSV_EPOCH" -gt 0 ]; then
  NEWEST_CSV_DATE="$(
    python3 -c 'import datetime, sys
print(datetime.datetime.fromtimestamp(int(sys.argv[1]), datetime.timezone.utc).strftime("%Y-%m-%d"))' "$NEWEST_CSV_EPOCH"
  )"
  NEWEST_CSV_AGE_DAYS=$(( (NOW - NEWEST_CSV_EPOCH) / 86400 ))
  if [ "$NEWEST_CSV_AGE_DAYS" -lt 0 ]; then
    NEWEST_CSV_AGE_DAYS=0
  fi
  NEWEST_CSV_AGE="${NEWEST_CSV_AGE_DAYS}d"
else
  NEWEST_CSV_DATE="none"
  NEWEST_CSV_AGE="n/a"
fi

LAST_RUN_STARTED="$(
  python3 -c 'import json, sys
try:
    started = json.load(open(sys.argv[1])).get("started_at")
except Exception:
    started = None
print(started if started else "none")' "$SCRAPER_REPO/data/regions/last-run-summary.json"
)"
LAST_RUN_EPOCH="$(
  python3 -c 'import json, sys
from datetime import datetime, timezone
try:
    started = json.load(open(sys.argv[1]))["started_at"]
    stamp = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    print(int(stamp.timestamp()))
except Exception:
    print(0)' "$SCRAPER_REPO/data/regions/last-run-summary.json"
)"
HOURS_SINCE_LAST_RUN="n/a"
LAST_RUN_STALE=0
if [ "$LAST_RUN_EPOCH" -gt 0 ]; then
  HOURS_SINCE_LAST_RUN="$(( (NOW - LAST_RUN_EPOCH) / 3600 ))h"
  # A perpetually-appending partial region keeps the newest CSV fresh, so the
  # start time of the last queue run is the staleness backstop for prune.
  if [ $(( NOW - LAST_RUN_EPOCH )) -gt $(( STALE_DAYS * 86400 )) ]; then
    LAST_RUN_STALE=1
  fi
fi

WORK_PENDING="$(
  python3 -c 'import json, sys
try:
    regions = json.load(open(sys.argv[1])).get("regions") or {}
    pending = any(r.get("status") in ("pending", "partial", "challenged") for r in regions.values())
except Exception:
    pending = False
print("true" if pending else "false")' "$SCRAPER_REPO/data/regions/queue-state.json"
)"
REGION_COUNT="$(ls "$SCRAPER_REPO"/regions/[a-z][a-z].json 2>/dev/null | wc -l | tr -d ' ')"
SLUGS="$(
  python3 -c 'import glob, json, os, sys
out = []
for path in sorted(glob.glob(os.path.join(sys.argv[1], "regions", "[a-z][a-z].json"))):
    prov = os.path.basename(path)[:-len(".json")]
    data = json.load(open(path))
    regions = data["regions"] if isinstance(data, dict) else data
    out.extend(r["city"] + "-" + prov for r in regions)
print(",".join(out))' "$SCRAPER_REPO"
)" || preflight_fail "regions files are unreadable"
[ -n "$SLUGS" ] || preflight_fail "regions files have no regions"

# Decision A: publish only when idle and a settled scrape is newer.
DO_PUBLISH=0
if [ "$RUNNING" = yes ]; then
  PUBLISH_REPORT="skipped (scrape running)"
elif [ "$NEWEST_CSV_EPOCH" -gt "$DATA_JSON_EPOCH" ]; then
  DO_PUBLISH=1
  PUBLISH_REPORT="planned"
else
  PUBLISH_REPORT="skipped (no newer csv)"
fi

# Decision B: start a refresh only when idle, with a start gap unless forced.
# REOPEN_ARGS maps the trigger to the wrapper argv: stale/force reopens every
# region (`done` included) and prunes delisted rows; pending-work-only resumes
# the queue as-is.
DO_REFRESH=0
REOPEN_ARGS=""
RECENT_START=0
if [ "$LAST_RUN_EPOCH" -gt 0 ] && [ $(( NOW - LAST_RUN_EPOCH )) -lt $(( MIN_RUN_GAP_HOURS * 3600 )) ]; then
  RECENT_START=1
fi
if [ "$RUNNING" = yes ]; then
  REFRESH_REPORT="skipped (scrape running)"
elif [ "$FORCE_REFRESH" -eq 0 ] && [ "$RECENT_START" -eq 1 ]; then
  REFRESH_REPORT="skipped (last run started ${HOURS_SINCE_LAST_RUN} ago, within ${MIN_RUN_GAP_HOURS}h gap)"
elif [ "$FORCE_REFRESH" -eq 1 ] || [ "$NEWEST_CSV_EPOCH" -eq 0 ] || [ $(( NOW - NEWEST_CSV_EPOCH )) -gt $(( STALE_DAYS * 86400 )) ] || [ "$LAST_RUN_STALE" -eq 1 ]; then
  DO_REFRESH=1
  REOPEN_ARGS="--reopen-all --prune"
  REFRESH_REPORT="planned (stale or force)"
elif [ "$WORK_PENDING" = true ]; then
  DO_REFRESH=1
  REFRESH_REPORT="planned (work pending)"
else
  REFRESH_REPORT="skipped (data fresh)"
fi

report() {
  echo "canada_refresh $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "running: $RUNNING"
  echo "regions: $REGION_COUNT files ($(echo "$SLUGS" | tr ',' '\n' | wc -l | tr -d ' ') slugs)"
  echo "newest_csv: $NEWEST_CSV_DATE (age $NEWEST_CSV_AGE)"
  echo "last_run_started: $LAST_RUN_STARTED"
  echo "publish: $PUBLISH_REPORT"
  echo "refresh: $REFRESH_REPORT"
}

finish() {
  report
  echo "STATUS: $1"
  exit "$2"
}

if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$DO_PUBLISH" -eq 1 ]; then
    PUBLISH_REPORT="planned (dry-run)"
    echo "would run: (cd $APP_REPO && python3 pipeline/build_dataset.py)"
    echo "would run: (cd $APP_REPO && python3 -m unittest discover -s pipeline/tests -q)"
    echo "would run: (cd $APP_REPO && MOCK_LLM=1 npm test)"
    echo "would run: (cd $APP_REPO && git commit -m \"Refresh Canada listing dataset ($NEWEST_CSV_DATE scrape)\" -- data/listings.json data/market_summary.json && git push origin main)"
  fi
  if [ "$DO_REFRESH" -eq 1 ]; then
    REFRESH_REPORT="$REFRESH_REPORT (dry-run)"
    echo "would run: (cd $SCRAPER_REPO && nohup scripts/pull_all_provinces.sh $REOPEN_ARGS </dev/null >/dev/null 2>&1 &)"
    # The path the real run would name (the wrapper is not launched here).
    WRAPPER_LOG="$SCRAPER_REPO/data/regions/logs/pull-$(date -u +%Y%m%dT%H%M%SZ).log"
    [ -f "$WRAPPER_LOG" ] || WRAPPER_LOG="$WRAPPER_LOG (not found yet)"
    echo "wrapper log: $WRAPPER_LOG"
  fi
  finish "success" 0
fi

if [ "$DO_PUBLISH" -eq 1 ]; then
  if ! ( cd "$APP_REPO" && python3 pipeline/build_dataset.py ); then
    PUBLISH_REPORT="failed (build)"
    finish "failed (build)" 2
  fi
  if ! ( cd "$APP_REPO" && python3 -m unittest discover -s pipeline/tests -q ); then
    echo "failing command: (cd $APP_REPO && python3 -m unittest discover -s pipeline/tests -q)"
    PUBLISH_REPORT="failed (tests)"
    finish "failed (tests)" 2
  fi
  if ! ( cd "$APP_REPO" && MOCK_LLM=1 npm test ); then
    echo "failing command: (cd $APP_REPO && MOCK_LLM=1 npm test)"
    PUBLISH_REPORT="failed (tests)"
    finish "failed (tests)" 2
  fi
  if git -C "$APP_REPO" diff --quiet HEAD -- data/; then
    echo "publish: no data change"
    PUBLISH_REPORT="skipped"
  else
    COMMIT_MSG="Refresh Canada listing dataset ($NEWEST_CSV_DATE scrape)"
    # Pathspec commit: only the two data files enter the commit even if the
    # working tree has unrelated staged edits.
    if ! git -C "$APP_REPO" commit -m "$COMMIT_MSG" -- data/listings.json data/market_summary.json >/dev/null; then
      PUBLISH_REPORT="failed (git commit)"
      finish "failed (git commit)" 2
    fi
    if push_error="$(git -C "$APP_REPO" push origin main 2>&1)"; then
      PUBLISH_REPORT="done $(git -C "$APP_REPO" rev-parse --short HEAD)"
    else
      echo "git push error: ${push_error%%$'\n'*}"
      PUBLISH_REPORT="failed (push)"
      finish "failed (push)" 2
    fi
  fi
fi

if [ "$DO_REFRESH" -eq 1 ]; then
  LAUNCH_EPOCH="$(date -u +%s)"
  ( cd "$SCRAPER_REPO" && nohup scripts/pull_all_provinces.sh $REOPEN_ARGS </dev/null >/dev/null 2>&1 & )
  # The wrapper tees to data/regions/logs/pull-<UTC>.log; name the newest file
  # written since the launch so an unattended failure is findable from here.
  sleep 2
  WRAPPER_LOG="$(ls -1t "$SCRAPER_REPO/data/regions/logs"/pull-*.log 2>/dev/null | head -1 || true)"
  [ -n "$WRAPPER_LOG" ] && [ "$(mtime "$WRAPPER_LOG")" -ge "$LAUNCH_EPOCH" ] || WRAPPER_LOG="(not found yet)"
  echo "wrapper log: $WRAPPER_LOG"
  # The wrapper may spend ~20s launching the attach Chrome before any scraper
  # process appears, so confirm on the launcher itself too.
  STARTED=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if pgrep -f "pull_all_provinces.sh" >/dev/null 2>&1 ||
       pgrep -f property-ontario >/dev/null 2>&1 ||
       pgrep -f property_scraper >/dev/null 2>&1; then
      STARTED=1
      break
    fi
    sleep 1
  done
  if [ "$STARTED" -eq 1 ]; then
    REFRESH_REPORT="started"
  else
    REFRESH_REPORT="failed (start)"
    finish "failed (start)" 2
  fi
fi

if [ "$DO_PUBLISH" -eq 1 ] || [ "$DO_REFRESH" -eq 1 ]; then
  finish "success" 0
fi
finish "skipped" 0
