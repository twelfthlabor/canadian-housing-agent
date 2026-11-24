# AGENTS.md: Canadian Housing Agent

Operating notes for coding agents. Quickstart, architecture, and dataset docs
live in README.md, docs/PLAN.md, and docs/DATA.md; don't duplicate them here.

## Commands

- `npm test`: vitest run over all tests under tests/ (tools, agent, guards, cache route, listings route, providers,
  observability, rag, mcp, langfuse, eval scoring). Single file: `MOCK_LLM=1 npx vitest run tests/tools.test.ts`.
- `npx tsc --noEmit`: typecheck. No linter or formatter is configured; don't add one.
- `npm run build`: next build, also typechecks. Next 16 rewrites `tsconfig.json` on build (adds its type includes):
  review the diff instead of reverting, keep TypeScript at 5.9.x. `next-env.d.ts` is gitignored (Next regenerates it).
- `npm run dev`: port 3000 (`PORT=3200 npm run dev` if busy). Prod: `npm run build && npm run start`.
- `python3 -m unittest discover -s pipeline/tests -v`: pipeline tests, stdlib only (no venv/pandas); CI pins Python
  3.11. Single test: add `-k <pattern>` (e.g. `-p test_build_dataset.py -k dedupe`).
- `python3 pipeline/build_dataset.py`: rebuilds `data/listings.json` + `data/market_summary.json` from the sibling
  scrape tree; `--source <dir>` and `--out <dir>` point elsewhere. Overwrites tracked data, so only run it to refresh.
- `npm run mcp`: MCP stdio server (`tsx mcp/server.ts`). npm's script banner goes to stdout, so MCP clients should
  spawn `npx --yes tsx <absolute-repo-path>/mcp/server.ts` (cwd-independent); stdout is protocol-only, diagnostics
  go to stderr. Read-only tools, no model calls.
- `npm run evals`: live, loads `.env.local` with Node 24, needs `GROQ_API_KEY`, sequential with `EVAL_DELAY_MS` default 2500.
  `MOCK_LLM=1 npm run evals`: plumbing only, no network, exit 0. Flags: `--category`, `--limit`, `--ids T01,D01`, `--mock`,
  `--resume` (keep completed rows from the last live report for the same model, run the rest), `--rescore` (re-score
  the saved answers in the last live report with the current checks, re-running only the deterministic tools). `GROQ_MODEL=<id>`
  runs the suite on another model; the report records `model`. Live runs retry a case up to twice (45s wait) when the
  provider returns an error, so rate limits are not scored as model failures. Writes `evals/report.json` (gitignored)
  after every case. 58 golden cases (27 tool choice including multi-turn MT01-MT04 and H04, capability cases
  C01/C02, deal D01, mortgage M01/M02, hard cases H01-H03/H06; 17 numeric including deal ND01/ND02, mortgage
  MN01/MN02 and thin-sample H05; 14 refusals); live bars: tool 0.9, numeric 0.95, refusal 1.0, plus a reported (not
  gated) `grounding_rate`. Mock scores are not a quality signal. Only a live report covering every case can pass the
  gate. Multi-turn cases score the final turn and require a tool on the first; `anyOf` lists alternatives; a
  `refusal`-type check doubles as a required-phrase check in non-refusal cases (H05, H06). Last completed
  full-suite pass: 58/58 on `openai/gpt-oss-120b` (2026-11-23), grounding_rate 1.0 over 229 figures.

## Environment

- `MOCK_LLM=1` (also `true`/`yes`) selects the deterministic mock provider and needs no keys. Unset with no key in
  dev it also mocks; in production a missing key emits a `misconfigured` error event.
- Live mode needs `GROQ_API_KEY`; put it in `.env.local` (gitignored: `.env.example` lists the names). `GROQ_MODEL`
  overrides the default `openai/gpt-oss-120b`. `GEMINI_API_KEY` (+ optional `GEMINI_MODEL`) is a fallback only when
  Groq fails before emitting.
- Langfuse tracing is optional: set `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` (+ optional `LANGFUSE_BASE_URL`)
  to enable metadata-only traces (turn duration/cache/tool names/error code; per-tool durations). Without both keys
  it is a full no-op.
- CI (`.github/workflows/ci.yml`): `npm ci`, `MOCK_LLM=1` vitest, `npm run build`, python unittest: Node 24 /
  Python 3.11. Evals are
  intentionally not in CI.

## Invariants

- `lib/tools.ts` is the single source of truth for tool schemas (`TOOL_SPECS`), implementations (`TOOL_IMPLS`),
  stats, and city alias normalization (`"St. Catharines"` -> `st-catharines`). Keep it deterministic, synchronous,
  free of LLM/network imports.
- `lib/grounding.ts` is pure: it extracts money, percent and plain-count (100+, not bare years) figures from an
  answer, strips URLs first, and matches each against the turn's tool results and the conversation text with a
  tolerance of max(1%, half a unit of the quoted precision). Address digits may ground plain numbers only. The agent
  emits `{type:"grounding",checked,ungrounded}` before `done`; the chat route recomputes it on cache replays. Any
  figure the prompt or a tool description tells the model to state must appear in the tool result (for example
  `gdsLimitPct`, `noiseFloorPct`, `thinSampleThreshold`), or the check will flag it.
- Same-type check (`sameTypeDiscountPct`/`passesTypeCheck` in `lib/tools.ts`): a typed listing with 5+ same-city,
  same-type, same-bedroom peers must also be at least the deal threshold below their median price; `find_deals`
  reports `excludedByType` and `typeChecked`, and `/api/listings?sort=discount` applies the same rule.
- `lib/grounding.ts` also anchors figures to listings: a line or sentence that names a listing's street address
  (unit numbers ignored) is checked against that listing's own fields plus shared totals, not every listing's prices.
- `lib/deals.ts` and `lib/sample.ts` hold the deal window (floor = max(dataset threshold, ceil(2 x city MdAPE)), cap
  50%) and the small-sample thresholds (100 for a caveat, 30 for a map label). They import no data, so client
  components use them too.
- `mcp/server.ts` reuses `TOOL_SPECS`/`TOOL_IMPLS` verbatim (schemas passed through; currently all six tools)
  and exposes only deterministic lookups. Keep it transport-only: no model calls, no side
  effects.
- Tool surface behavior: `city_snapshot` accepts optional `minPrice`/`maxPrice`/`beds`/`bathsMin` and computes stats
  over the matching rows (`null` when nothing matches). `rank_areas` ranks a city's FSAs by `median_price` or `count`,
  keeps only areas with 5 or more matching listings, defaults to 5 rows (max 10), and returns `considered` (matching
  listings with an FSA) and `totalAreas` (areas that cleared the threshold). `search_listings` filters price, exact
  beds, and FSA but not bathrooms; `rank_areas` and filtered snapshots do. `find_deals` lists a city's listings
  asking below the hmb-v1 estimate: optional `minDiscount` (default the city's noise floor from `lib/deals.ts`;
  an explicit value is honoured, clamped 0-50, with a `note` when below the floor), `minPrice`/`maxPrice`, exact
  `beds`, and `limit` 1-25 (default 5); the result `{city,minDiscount,considered,totalMatches,returned,listings,
  typicalErrorPct,noiseFloorPct,maxDiscountPct,note?}` is sorted by `discountPct` desc, and rows without a
  usable estimate or below the $100,000 deal floor are excluded from `considered`; `null` for an unknown city.
- `lib/mortgage.ts` is pure arithmetic with no network or LLM imports, shared by the `mortgage_estimate` tool and the
  city tray. Canadian rules live there: 5/10/20% minimum down tiers, no insured mortgage above $1.5m, CMHC premium
  bands below 20% down, semi-annual compounding, the greater of contract +2% and 5.25% for the stress test, and a 39%
  GDS income estimate (property tax 1% of price, heat $150/month). `mortgage_estimate` takes `price`, `householdIncome`,
  or both; `householdIncome` adds `maxAffordablePrice` from `maxPriceForIncome` (bisection over price). Answers quote the
  insured loan (loan plus premium), since the payment is calculated on it.
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
  never log messages, keys, or IPs. Optional Langfuse traces carry the same metadata when keys are set (see the
  Environment bullet); these lines remain the keyless fallback.
- `lib/langfuse.ts` (called from `app/api/chat/route.ts`) sends metadata only while both keys are set: one
  `chat_turn` trace (`durationMs`, `cached`, `tools`, `errorCode`) plus one span per tool call (`tool:<name>`,
  `durationMs`). Never send messages, answers, tool arguments, queries, keys, or IPs; never throw (disabled = no-op;
  the SDK is imported lazily only when enabled).
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
  time (max(15, ceil(OOF MdAPE/5)*5), capped 50). `market_summary.valuation` carries the overall `oof_mdape_pct`, the
  per-city `oof_mdape_pct_by_city` map (shown in the UI as each city's typical error), and `min_discount_pct`, which
  `find_deals` and `/api/listings` read at runtime. `build_dataset.py` runs it in the same refresh: no extra step,
  dependency, or network call.
- Rows in `data/listings.json` are exactly
  `{city,province,fsa,price,beds,baths,sqft,seen,address,url,type,estValue,discountPct}` (54,658 rows, 123 cities, 11
  provinces). `type` is Zillow's homeType or null (43.5% typed): `build_dataset.py` carries the scraper CSV's `type`
  column, and `pipeline/enrich_types.py --cache <scraper>/cache --data data` backfills by zpid without erasing CSV
  values; `canada_refresh.sh` runs it after the build when the cache exists. `estValue` is a positive integer CAD rounded to the nearest $1,000; `discountPct` has one decimal and is
  positive when the asking price is below the estimate; both are null for listings in cities with fewer than 30 rows
  (208 rows in 19 cities today). Address and source URL are intentionally published; never reintroduce `listing_id`, agent names, or
  scraped source pages into tracked data. `sqft` outside 200-20,000 is nulled (land acreage bug); per-city `medianSqft`
  is null under 10 samples.
- `/api/listings` GET serves the Data tab and is national by default. The explorer's state round-trips through `d*`
  URL params (see `filtersFromParams` in `components/DataTable.tsx`). JSON `{total, returned, offset, nextOffset, listings}`
  with optional `city`, `province` (two-letter code), `fsa`, `beds` (exact), `minPrice`/`maxPrice`, `q` (free text over
  address, city and FSA), `sort` (`price_asc` default, `price_desc`, `newest` by `seen`, or `discount`, which uses
  `minDiscount` defaulting to the valuation meta threshold, clamped 0-50, and raised per row to that city's noise floor), `limit` (default 100, capped at 200) and
  `offset`. Invalid filter values are ignored, not errors. `parseFilters` and `queryListings` are the pure core. Or
  `?format=csv` returning all rows with the header
  `city,province,fsa,price,beds,baths,sqft,seen,address,url,type,estValue,discountPct` (`null` -> empty cell; RFC 4180
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
