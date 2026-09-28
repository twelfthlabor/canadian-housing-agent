# AGENTS.md: Canadian Housing Agent

Operating notes for coding agents. Quickstart, architecture, and dataset docs
live in README.md, docs/PLAN.md, and docs/DATA.md; don't duplicate them here.

## Commands

- `npm test`: vitest run over all tests under tests/ (tools, agent, guards, cache route, listings route, providers,
  observability, eval scoring). Single file: `MOCK_LLM=1 npx vitest run tests/tools.test.ts`.
- `npx tsc --noEmit`: typecheck. No linter or formatter is configured; don't add one.
- `npm run build`: next build, also typechecks. Next 16 rewrites `tsconfig.json` on build (adds its type includes):
  review the diff instead of reverting, keep TypeScript at 5.9.x. `next-env.d.ts` is gitignored (Next regenerates it).
- `npm run dev`: port 3000 (`PORT=3200 npm run dev` if busy). Prod: `npm run build && npm run start`.
- `python3 -m unittest discover -s pipeline/tests -v`: pipeline tests, stdlib only (no venv/pandas); CI pins Python
  3.11. Single test: add `-k <pattern>` (e.g. `-p test_build_dataset.py -k dedupe`).
- `python3 pipeline/build_dataset.py`: rebuilds `data/listings.json` + `data/market_summary.json` from the sibling
  scrape tree; `--source <dir>` and `--out <dir>` point elsewhere. Overwrites tracked data, so only run it to refresh.
- `npm run evals`: live, loads `.env.local` with Node 24, needs `GROQ_API_KEY`, sequential with `EVAL_DELAY_MS` default 2500.
  `MOCK_LLM=1 npm run evals`: plumbing only, no network, exit 0. Flags: `--category`, `--limit`, `--mock`. Writes
  `evals/report.json` (gitignored). 47 golden cases (20 tool choice including multi-turn MT01-MT04, capability
  cases C01/C02, and deal tool-choice D01; 14 numeric including deal cases ND01/ND02; 13 refusals); live bars: tool
  0.9, numeric 0.95, refusal 1.0; mock scores are not a quality signal. Partial runs cannot satisfy the full
  quality gate. Multi-turn cases run 2-3 user turns, score only the final turn, and require a tool on the first
  turn; expectations may list `anyOf` alternatives; the report is rewritten after each case, so an aborted run keeps
  partial results. Last completed full-suite pass: the 32-case gate (2026-09-16); the 47-case suite has not
  completed a live run.

## Environment

- `MOCK_LLM=1` (also `true`/`yes`) selects the deterministic mock provider and needs no keys. Unset with no key in
  dev it also mocks; in production a missing key emits a `misconfigured` error event.
- Live mode needs `GROQ_API_KEY`; put it in `.env.local` (gitignored: `.env.example` lists the names). `GROQ_MODEL`
  overrides the default `openai/gpt-oss-120b`. `GEMINI_API_KEY` (+ optional `GEMINI_MODEL`) is a fallback only when
  Groq fails before emitting.
- CI (`.github/workflows/ci.yml`): `npm ci`, `MOCK_LLM=1` vitest, `npm run build`, python unittest: Node 24 /
  Python 3.11. Evals are intentionally not in CI.

## Invariants

- `lib/tools.ts` is the single source of truth for tool schemas (`TOOL_SPECS`), implementations (`TOOL_IMPLS`),
  stats, and city alias normalization (`"St. Catharines"` -> `st-catharines`). Keep it deterministic, synchronous,
  free of LLM/network imports.
- Tool surface behavior: `city_snapshot` accepts optional `minPrice`/`maxPrice`/`beds`/`bathsMin` and computes stats
  over the matching rows (`null` when nothing matches). `rank_areas` ranks a city's FSAs by `median_price` or `count`,
  keeps only areas with 5 or more matching listings, defaults to 5 rows (max 10), and returns `considered` (matching
  listings with an FSA) and `totalAreas` (areas that cleared the threshold). `search_listings` filters price, exact
  beds, and FSA but not bathrooms; `rank_areas` and filtered snapshots do. `find_deals` lists a city's listings
  asking below the hmb-v1 estimate: optional `minDiscount` (default from the valuation metadata, fallback 15, clamped
  0-60), `minPrice`/`maxPrice`, exact `beds`, and `limit` 1-25 (default 5); the result
  `{city,minDiscount,considered,totalMatches,returned,listings}` is sorted by `discountPct` desc, and rows without a
  usable estimate or below the $100,000 deal floor are excluded from `considered`; `null` for an unknown city.
- FSA narrowing: `search_listings` takes an optional `fsa`; `city_snapshot` takes `{city, fsa}` (a bare string still
  works internally for `compare_cities`). Full postal codes reduce to the leading 3-character FSA (`"M6P 1A1"` ->
  `"M6P"`); rows without an FSA are excluded when a filter is set, and a scoped snapshot returns null when the FSA
  has no rows.
- `lib/agent.ts` is the typed-event agent loop: hard caps 3 tool iterations / 4 LLM calls per turn. `SYSTEM_PROMPT`
  requires a tool call for every number, asks one brief question when a required detail (for example the city) is
  missing instead of declining, and requires any decline to name the specific limitation in one line.
  `lib/providers.ts` calls Groq with plain `fetch` (no SDK dependency, 20s timeout per call), plus mock and optional
  Gemini providers.
- Client-visible errors are stable codes only (`provider_error`, `misconfigured`, `rate_limited`,
  `budget_exhausted`); real details stay in server logs.
- `lib/observability.ts` writes one metadata-only JSON line per operational event: `chat_turn` per turn
  (`durationMs`, `cached`, `tools`, `errorCode`) and `rate_limited`. Content-like keys are stripped before logging;
  never log messages, keys, or IPs. Langfuse is still not built (it needs account keys); these lines are the intended
  feed.
- Chat provenance (`components/Chat.tsx`): tool-using answers render a collapsed "How this answer was computed"
  block with the raw tool id, the raw arguments the model sent (humanized where known: city, beds, minPrice/maxPrice,
  fsa, sort, bathsMin, minDiscount, metric, order, limit), and the muted result summary. Cached answers replay the
  stored tool events, so the block renders on cache hits too.
- `/api/chat` SSE events: `text`, `tool`, `tool_result`, `cached`, `done`, `error`. `tool_result` carries `data` with
  the raw result: search `{totalMatches, returned, listings}` (rows as-is), snapshot object, compare array. Mismatched
  `Origin` -> 403 and non-exact `application/json` -> 415, both before rate limiting; GET -> 405. Node runtime (not
  edge); bodies keep the last 20 messages, 4,000 chars each.
- `lib/guards.ts` is in-process best-effort: 5 req/min + 30/day per IP (`x-vercel-forwarded-for`, then
  `x-forwarded-for`), 800 LLM calls/day global, 200-entry LRU standalone-question cache (normalized, 15-minute TTL).
  History-bearing requests bypass the cache; only completed, error-free answers are stored. Entries keep the answer's
  `tool`/`tool_result` display events, so a hit replays `cached -> tool -> tool_result -> text -> done`.
  Cache hits remain per-IP rate limited, but can be served after the LLM budget runs out.
  Per instance, resets on cold start; never a security boundary.
- `pipeline/build_dataset.py` (stdlib only, run from repo root): dedupe by listing id (newest `scraped_at` wins; the
  id is never emitted), filter, write `data/listings.json` + `data/market_summary.json`. Default `--source` is the
  sibling `../property-scraper/data/regions`; `--out` defaults to `data/`. `lib/dataset.ts` imports both tracked files
  directly (no database, no runtime reads). No enriched/local export mode exists; don't reintroduce one.
- `pipeline/valuation.py` (`hmb-v1`) is stdlib-only and deterministic (no RNG or clock; `crc32` duplicate-aware
  grouped fold assignment): a hierarchical median-residual model on `ln(price)` whose published estimates are 5-fold
  out-of-fold predictions plus
  one median bias correction; only cities with 30+ rows are estimated, and `min_discount_pct` is measured at build
  time (max(15, ceil(OOF MdAPE/5)*5), capped 60). `market_summary.valuation` carries the overall `oof_mdape_pct`, the
  per-city `oof_mdape_pct_by_city` map (shown in the UI as each city's typical error), and `min_discount_pct`, which
  `find_deals` and `/api/listings` read at runtime. `build_dataset.py` runs it in the same refresh: no extra step,
  dependency, or network call.
- Rows in `data/listings.json` are exactly
  `{city,province,fsa,price,beds,baths,sqft,seen,address,url,estValue,discountPct}` (42,888 rows, 123 cities, 11
  provinces). `estValue` is a positive integer CAD rounded to the nearest $1,000; `discountPct` has one decimal and is
  positive when the asking price is below the estimate; both are null for listings in cities with fewer than 30 rows
  (195 rows today). Address and source URL are intentionally published; never reintroduce `listing_id`, agent names, or
  scraped source pages into tracked data. `sqft` outside 200-20,000 is nulled (land acreage bug); per-city `medianSqft`
  is null under 10 samples.
- `/api/listings` GET serves the Data tab: JSON `{total, returned, listings}` for one city (default limit 100, capped
  at 200), `sort=price` (ascending, the default) or `sort=discount` (descending, with `minDiscount` defaulting to the
  valuation meta threshold and clamped 0-60), or `?format=csv` returning all rows with the header
  `city,province,fsa,price,beds,baths,sqft,seen,address,url,estValue,discountPct` (`null` -> empty cell; RFC 4180
  quoting, formula-looking cells prefixed with `'`, serialized once per server process).
- Atlas URL state (`components/Workspace.tsx`): city, compare, sort, max, tab, and view are mirrored with one-way
  `replaceState`; defaults are omitted, `max` snaps to the 50k slider step, and unknown params fall back to defaults.
  Share-only: back/forward does not resync it.
- Rebuilds are byte-identical only with a fixed `SOURCE_DATE_EPOCH`; otherwise `generated_at` changes.
- Eval expected values come from `lib/tools` at runtime; never hardcode dataset numbers in `evals/cases.jsonl`. The
  scoring rules live in that file's `_doc` line and in `evals/run.ts`: per-case phrase patterns plus a structural
  refusal rule (decline marker within 100 characters of the case's limitation subject), strict per-case forbid
  patterns, and ungrounded-number checks. Tool choice passes when any tool event in the turn matches the expected tool
  and args; an answer that is only a tool-limit or budget notice fails.

## Don't

- Never hand-edit `data/*.json`: change the pipeline and regenerate. The ~13 MB JSON is tracked on purpose; don't
  gitignore it.
- `../property-scraper` is a read-only data source: never modify it or run its scraper from here.
- Never commit, push, deploy, or enable provider billing: free tier only. Never print keys into logs or client code.
- Don't package or share `.next/`: the gitignored build cache can hold build-time env values.
- After touching `lib/guards.ts`, `lib/providers.ts`, or `app/api/chat/route.ts`: re-run the affected vitest files
  and smoke-test with curl: 415 wrong content type, 403 mismatched Origin, 429 6th request in a minute, security
  headers present.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
