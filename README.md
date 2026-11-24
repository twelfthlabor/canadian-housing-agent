# Canadian Housing Agent

A tool-calling LLM agent that answers questions about 54,658 Canadian for-sale
listings across 123 cities in 11 provinces, and checks where its numbers come
from. The model only picks tools and writes the reply; prices, counts and
percentages come from deterministic functions over the dataset, and each answer
is checked against the tool results and flagged when a figure does not match.

Live demo: https://canadian-housing-agent.vercel.app

Not an appraisal service, listing service, or source of financial advice. See
[Disclaimers](#disclaimers).

## What makes it different

- **Answers are checked, not trusted.** After every answer, `lib/grounding.ts`
  extracts each money figure, percentage and count and matches it against that
  turn's tool results and the conversation, allowing only the rounding the
  answer itself shows ("$1.3 million" covers $1,325,000). The UI prints "All N
  figures match the tool results below" or names the figures it could not
  trace. The same check scores the eval suite. It is a match against the
  numbers the tools returned, not a proof: see [How strict the check
  is](#how-strict-the-check-is).
- **Deals have to clear the model's own error.** `find_deals` only calls a
  listing a deal when its gap to the comparable-listings estimate is at least
  twice that city's typical estimate error (out-of-fold MdAPE) and at most 50%.
  Where the property type is known, the discount must also hold against
  same-city, same-type, same-bedroom listings, because the estimate mixes
  condos and houses: of 895 typed deals, 579 were only cheap next to another
  property type. In Hamilton that leaves 38 deals instead of the 425 a flat
  20% threshold produced; where the estimate is too noisy, the tool returns no
  deals and says why.
- **Small samples are labelled.** 48 of 123 cities have fewer than 100
  listings. Their medians carry a small-sample flag in the tool result, a
  caveat in the answer, a dashed label on the map, and no headline label at all
  under 30 listings.
- **Everything is shown.** Tool-using answers include a "How this answer was
  computed" block with the raw tool calls and results.

## Results

| Check | Result |
| --- | --- |
| Live eval, 58 cases on `openai/gpt-oss-120b` (2026-11-23) | 58/58: tool choice 1.00, numeric 1.00, refusals 1.00; quality gate passed |
| Grounding on that run | 229 figures in 44 answers, every one traced to a tool result |
| Unit and route tests (`npm test`) | 258 passing |
| Pipeline tests (`python -m unittest discover -s pipeline/tests`) | 40 passing |
| Mobile Lighthouse on production (accessibility / best practices / SEO) | 100 / 100 / 100 |

How the live result was reached: the first pass scored 56/58. One case hit a
Groq service error; the other failure and four grounding flags were checker
bugs, not model errors (gpt-oss writes a narrow no-break space as a thousands
separator, "$763 000", and states a negative discount as "3.6% above"). After
fixing the checker, `--rescore` re-scored the saved answers without new model
calls (57/58) and `--resume` re-ran the service-error case live (58/58).

## How strict the check is

Measured on real tool results for the 20 largest cities: each returned figure
was moved up and down by 5%, 10% and 20%, rounded to the nearest $1,000, and
put through the same check, written the way the agent writes it (listing
prices next to the listing's address). Every unmodified figure was accepted.

| Tool result | Wrong figure still accepted (±5% / ±10% / ±20%) |
| --- | --- |
| `city_snapshot` | 4.4% / 8.1% / 3.8% |
| `search_listings` (25 listings) | 5.6% / 4.3% / 3.5% |
| `find_deals` (25 listings with estimates) | 0.1% / 0.0% / 0.1% |

A line or sentence that names a listing's address is checked against that
listing's own figures and the result's shared totals only; before that rule,
listing results let 30-55% of wrong prices through because some other
listing's price was usually within 1%. A price quoted without its address is
still matched against every number in the result.

## What the agent can do

Six tools, all deterministic and read-only:

| Tool | Answers |
| --- | --- |
| `city_snapshot` | Median, quartiles, count, share under $1M and median by bedrooms for a city, optionally filtered by FSA, price, beds or baths |
| `search_listings` | Matching listings with address and source link, up to six as cards |
| `compare_cities` | Side-by-side snapshots |
| `rank_areas` | A city's postal areas (FSAs) by median asking price or listing count |
| `find_deals` | Listings asking well below the comparable-listings estimate, within the noise rules above |
| `mortgage_estimate` | Minimum down payment, CMHC premium, monthly payment, OSFI stress test and the income the 39% GDS limit implies; or the highest price an income supports |

The atlas around the chat has a map, a city list with a price ceiling, a
two-city comparison, an affordability calculator using the same arithmetic as
the agent tool, and a Data tab: a national listings explorer with filters,
sorts, paging and CSV export. View state is mirrored into the URL.

## Quickstart

Requires Node.js 24 and Python 3. Run commands from this directory, with the
`property-scraper` checkout as a sibling.

```bash
npm install
python3 pipeline/build_dataset.py            # writes data/listings.json + data/market_summary.json
MOCK_LLM=1 npm run dev                       # open the URL printed by Next.js
npm test                                     # vitest: tools, agent, grounding, guards, routes, providers, observability, mcp, langfuse, evals
npm run build                                # production build; npm start serves it
MOCK_LLM=1 npm run evals                     # golden harness, plumbing only (no network)
```

`MOCK_LLM=1` runs a deterministic mock instead of calling Groq, so the
quickstart needs no API key. For the real model, put `GROQ_API_KEY` in
`.env.local` and run `npm run dev` without `MOCK_LLM=1`.

`pipeline/build_dataset.py` reads `../property-scraper/data/regions` by
default; pass `--source <dir>` to point it elsewhere. Listing ids are used for
dedupe and never written.

## Evals

`npm run evals` runs 58 golden cases against the real agent loop, prompt and
provider: 27 tool-choice cases (including misspelled cities, a two-tool
question, elliptical follow-ups and a too-noisy deal city), 17 numeric cases
whose expected values are computed from the dataset at run time, and 14
refusals. Live bars: tool choice >= 0.90, numeric >= 0.95, refusals 1.00. The
report also records a `grounding_rate`: the share of answers with figures where
every figure traced to a tool result.

```bash
npm run evals                                # full live run, needs GROQ_API_KEY
npm run evals -- --resume                    # keep completed rows from the last report for the same model, run the rest
npm run evals -- --rescore                   # re-score the last report's saved answers with the current checks (no model calls)
GROQ_MODEL=<model id> npm run evals          # run the same suite on another Groq model; the report records the model
npm run evals -- --category numeric          # one category (never passes the full-suite gate)
```

Each run writes `evals/report.json` (gitignored) after every case, so an
aborted run keeps its rows. `quality_gate_passed` is true only for a live run
whose rows cover every case.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GROQ_API_KEY` | Groq API key. Required to call the real model; not needed with `MOCK_LLM=1`. |
| `GROQ_MODEL` | Override the Groq model id; the demo uses `openai/gpt-oss-120b`. |
| `GEMINI_API_KEY` | Optional fallback provider, used only when set and a Groq call fails before emitting output. Keep billing disabled on both accounts. |
| `GEMINI_MODEL` | Optional fallback model override; defaults to `gemini-2.5-flash-lite`. |
| `MOCK_LLM` | Set to `1` to use the deterministic mock LLM (tests/CI; no key needed). |
| `LANGFUSE_PUBLIC_KEY` | Optional Langfuse public key. Set with the secret key to enable metadata-only tracing. |
| `LANGFUSE_SECRET_KEY` | Optional Langfuse secret key. |
| `LANGFUSE_BASE_URL` | Optional Langfuse endpoint override; defaults to Langfuse cloud. |

## Architecture

```
property-scraper/  (separate repo; read-only here)
  data/regions/<city>/listings.csv
        |
        v
pipeline/build_dataset.py   dedupe by listing id -> filter -> extract FSA -> hmb-v1
                            valuation -> write thirteen fields (incl. type, estValue/discountPct)
pipeline/enrich_types.py    backfills property type from the scraper cache
        |
        v
data/listings.json          54,658 listings incl. province, address, source URL,
                            estValue + discountPct
data/market_summary.json    per-city aggregates and valuation error by city
        |
        v
lib/tools.ts                deterministic search/stats tools + OpenAI-style tool schemas
lib/deals.ts, lib/sample.ts deal-window and small-sample rules shared with the UI
lib/mortgage.ts             Canadian mortgage arithmetic (CMHC, stress test, GDS)
        |
        v
lib/agent.ts                tool loop (3 tool calls, 4 LLM calls per turn)
lib/grounding.ts            checks the final answer's figures against the tool results
        |
        v
/api/chat (Next.js)         streamed over SSE
        |    events: text, tool, tool_result, grounding, cached, done, error
        |    guardrails: 5 req/min + 30 req/day per IP, 800 LLM calls/day global,
        |                standalone exact-question cache (15-minute TTL)
        v
Groq openai/gpt-oss-120b    primary free provider (MOCK_LLM=1 -> deterministic mock)
Gemini gemini-2.5-flash-lite     optional fallback when GEMINI_API_KEY is set and Groq fails
```

Each turn logs one metadata-only `chat_turn` line (duration, cache hit, tool
names, error code, figures checked and figures not traced); message content,
answers and IPs are never logged.

## MCP server

`mcp/server.ts` exposes the same six tools over MCP stdio, reusing
`TOOL_SPECS` and `TOOL_IMPLS` verbatim. Every tool is a deterministic,
read-only lookup with no model call. Point a client at an absolute path:

```json
{
  "mcpServers": {
    "canadian-housing-agent": {
      "command": "npx",
      "args": ["--yes", "tsx", "/absolute/path/to/canadian-housing-agent/mcp/server.ts"]
    }
  }
}
```

`npm run mcp` starts the same server for interactive use, but npm's script
banner is written to stdout and would pollute the protocol stream; clients
should spawn the command above instead.

## Optional Langfuse tracing

Tracing is off unless `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set.
When enabled, each chat turn emits one trace (`durationMs`, `cached`, `tools`,
`errorCode`) plus one span per tool call. Messages, answers, tool arguments
and IPs are never sent; tracing failures can never affect a request.

## Project layout

```
canadian-housing-agent/
├── app/                      Next.js app: /api/chat SSE route, /api/listings JSON+CSV route, atlas UI
├── components/               atlas and chat UI (DataTable.tsx backs the Data tab)
├── lib/                      agent.ts, tools.ts, grounding.ts, deals.ts, sample.ts, mortgage.ts, providers.ts, guards.ts, observability.ts, langfuse.ts
├── mcp/                      MCP stdio server reusing TOOL_SPECS (read-only)
├── pipeline/                 Python data build and hmb-v1 valuation; stdlib unittest coverage
├── data/                     generated listings.json + market_summary.json
├── scripts/                  canada_refresh.sh (scheduled refresh), build_geography.py
├── evals/                    58 golden cases + run.ts harness (report.json gitignored)
├── tests/                    vitest suites
└── docs/                     STATUS, PLAN, DATA, DEMO
```

## Documentation

- [docs/STATUS.md](docs/STATUS.md): latest verified state, fixes, and next steps.
- [docs/PLAN.md](docs/PLAN.md): architecture details, milestones, constraints.
- [docs/DATA.md](docs/DATA.md): what the dataset contains and how to refresh it.
- [docs/DEMO.md](docs/DEMO.md): 2-3 minute demo run-through.

## Disclaimers

- The dataset is a research sample of public for-sale listing data from
  Zillow, collected with Zillow's permission. It includes each listing's
  address and a link to the source listing; listing ids, agent names, and
  scraped source pages are not published. Not affiliated with or endorsed by
  Zillow.
- Asking prices only; no sold prices. Square footage covers 57.5% of rows and
  is city-skewed; values outside a plausible 200-20,000 sqft range are treated
  as missing. The sample is a single snapshot and can be stale.
- Coverage is uneven: Ontario and British Columbia dominate, and Quebec and
  Manitoba have few listings.
- `estValue`/`discountPct` estimate the typical asking price from comparable
  asking prices: not an appraisal, not sold prices, not investment advice. They
  use no property type, condition, lot, or sold data, so a large gap can be a
  condo or mobile home compared with houses. Estimates typically err by about
  ±19% overall, shown per city in the UI.
- Nothing here is financial, legal, or real-estate advice.
- The demo runs on free tiers: Groq for the model and Vercel Hobby for hosting.
  Exhausting the daily free-tier token quota can make it unavailable during
  traffic spikes.

## License

PolyForm Noncommercial 1.0.0: free for personal, research, and other
noncommercial use; commercial use requires permission. See [LICENSE](LICENSE).
