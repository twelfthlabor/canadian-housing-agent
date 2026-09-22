#!/usr/bin/env bash
# Install (or refresh) the launchd agent that runs scripts/canada_refresh.sh
# every 24 hours. Idempotent: rerun after moving the checkout or editing paths.
# Uninstall: launchctl bootout gui/$(id -u)/local.canada-refresh \
#            && rm ~/Library/LaunchAgents/local.canada-refresh.plist
# The old local.ontario-refresh job must be uninstalled separately if present:
#            launchctl bootout gui/$(id -u)/local.ontario-refresh \
#            && rm ~/Library/LaunchAgents/local.ontario-refresh.plist
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_REPO="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
DRIVER="$APP_REPO/scripts/canada_refresh.sh"
LABEL="local.canada-refresh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
LOG_FILE="$APP_REPO/output/refresh.log"

[ -x "$DRIVER" ] || { echo "ERROR: $DRIVER is missing or not executable" >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG_FILE")"

# launchd starts jobs with a minimal PATH; carry this shell's tool directories
# over so node/npm/python3 (Homebrew) resolve, plus the system defaults.
TOOL_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
for tool in npm python3 git; do
  dir="$(dirname "$(command -v "$tool" 2>/dev/null || echo "/usr/bin/$tool")")"
  case ":$TOOL_PATH:" in *":$dir:"*) ;; *) TOOL_PATH="$dir:$TOOL_PATH" ;; esac
done

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$DRIVER</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$APP_REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$TOOL_PATH</string>
  </dict>
  <key>StartInterval</key>
  <integer>86400</integer>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST" >/dev/null
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true

echo "installed: $PLIST"
echo "driver:    $DRIVER"
echo "schedule:  every 24 h (StartInterval 86400); nothing runs at load"
echo "log:       $LOG_FILE"
echo "status:    launchctl print $DOMAIN/$LABEL | grep -E 'state|last exit'"
echo "run now:   launchctl kickstart -k $DOMAIN/$LABEL"
echo "uninstall: launchctl bootout $DOMAIN/$LABEL && rm $PLIST"
