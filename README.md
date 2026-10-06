# Canadian Housing Agent

A free public demo where visitors chat with a tool-calling LLM agent about a
research sample of 50,014 Canadian for-sale listings across 123 cities in 11 provinces. The agent
answers questions like "median asking price for a 3-bed in Hamilton?" or "how
many listings are in M6P?" by calling deterministic search and stats functions
over a JSON dataset. Numbers come from those functions; the model picks tools
and writes the reply. Search and snapshot tools accept a 3-character FSA (a full
postal code is reduced to it), and snapshots accept price, bedroom, and
minimum-bath filters. The agent can also rank a city's postal areas by median
asking price or listing count, and it can surface listings asking below an
offline comparable-listings estimate (`find_deals`): the estimated typical
asking price from comparable asking prices, not an appraisal, sold price, or
investment advice. Search answers render up to six listing cards (each with its
address and a link to the source listing) and a sample-size line. Tool-using
answers include a collapsed "How this answer was computed" block with the raw
tool calls. The atlas has a Data tab with a CSV export and a biggest-discount
sort, and its state (city, compare pair, sort, price ceiling, tab, view) is
mirrored into the URL so a view can be shared. The agent has six tools;
`search_docs` answers questions about the project itself from its own
documentation (see [Docs search](#docs-search-search_docs)).

Live demo: https://canadian-housing-agent.vercel.app

Not an appraisal service, listing service, or source of financial advice. See
[Disclaimers](#disclaimers).

## Who it is for

- Visitors who want quick, data-grounded answers about asking prices in the
  covered cities.
- Developers looking for a small, readable example of a tool-calling agent loop
  with rate-limit guardrails and a deterministic offline test mode.

## Quickstart

These steps run the demo locally; the live demo is at the URL above.
Requires Node.js 24 and Python 3. Run all commands from this directory
(`canadian-housing-agent/`), with the `property-scraper` checkout as a sibling.

```bash
npm install
npm run embed:docs                           # writes data/docs_index.json (docs search index)
python3 pipeline/build_dataset.py            # writes data/listings.json + data/market_summary.json
MOCK_LLM=1 npm run dev                       # open the URL printed by Next.js
npm test                                     # vitest: tools, agent, guards, routes, providers, observability, rag, mcp, langfuse, evals
npm run build                                # production build; npm start serves it
MOCK_LLM=1 npm run evals                     # golden harness, plumbing only (no network)
```

`MOCK_LLM=1` runs a deterministic mock instead of calling Groq, so the quickstart
needs no API key. For the real model, put `GROQ_API_KEY` in `.env.local` and run `npm run dev`
without `MOCK_LLM=1`. The app shows an offline-demo notice when using scripted replies.
Both Next.js and `npm run evals` load `.env.local`; exported environment variables
take precedence for the eval command. Restart the server after changing providers or data.

`npm run evals` runs the 48 golden cases (21 tool choice, including 4
multi-turn cases, 2 capability cases for filtered snapshots and area rankings,
3 Canada tool cases, 1 deal case, and 1 docs case for `search_docs`; 14
numeric, including 2 deal cases; 13 refusals) and needs `GROQ_API_KEY` for live scoring;
without a key it exits 1 with instructions. `MOCK_LLM=1 npm run evals` runs the
plumbing only. Each run writes `evals/report.json`, which is gitignored, and
the harness updates it after every case so an aborted run keeps partial
results. Reports include the answers and tool arguments for diagnosis. Live
bars: tool choice >= 0.90, numeric >= 0.95, refusals 1.00. `quality_gate_passed`
stays false for mock runs and partial runs (`--limit` or `--category` selecting
fewer than all cases), even if their selected cases pass. The last completed
full live pass is the 32-case gate from 2026-09-16; the 48-case suite has not
completed a live run (2026-09-17 attempts hit the Groq free-tier daily token
cap).

`pipeline/build_dataset.py` reads `../property-scraper/data/regions` by default;
pass `--source <dir>` to point it elsewhere. Listing ids are used for dedupe and
never written.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GROQ_API_KEY` | Groq API key. Required to call the real model; not needed with `MOCK_LLM=1`. |
| `GROQ_MODEL` | Override the Groq model id; the demo uses `openai/gpt-oss-120b`. |
| `GEMINI_API_KEY` | Optional fallback provider, used only when set and a Groq call fails before emitting output. Groq remains the primary free provider. Keep billing disabled on both accounts. |
| `GEMINI_MODEL` | Optional fallback model override; defaults to `gemini-2.5-flash-lite`. |
| `MOCK_LLM` | Set to `1` to use the deterministic mock LLM (tests/CI; no key needed). |
| `LANGFUSE_PUBLIC_KEY` | Optional Langfuse public key. Set with the secret key to enable metadata-only tracing; unset means tracing is a no-op. |
| `LANGFUSE_SECRET_KEY` | Optional Langfuse secret key. |
| `LANGFUSE_BASE_URL` | Optional Langfuse endpoint override (for example a self-hosted instance); defaults to Langfuse cloud. |
| `DATABASE_URL` | Optional Postgres connection for the local pgvector demo (`npm run seed:pgvector`); defaults to `postgres://postgres:postgres@localhost:5432/agent`. Not read by the app at runtime. |

## Architecture

```
property-scraper/  (separate repo; read-only here)
  data/regions/<city>/listings.csv
        |
        v
pipeline/build_dataset.py   dedupe by listing id -> filter -> extract FSA -> hmb-v1
                            valuation -> write twelve fields (incl. estValue/discountPct)
        |
        v
data/listings.json          50,014 listings incl. province, address, source URL,
                            estValue + discountPct
data/market_summary.json    per-city aggregates
        |
        v
lib/tools.ts                deterministic search/stats (incl. rank_areas, find_deals, search_docs) + OpenAI-style tool schemas
lib/embed.ts + lib/rag.ts   pure hash-v1 encoder + docs-index cosine retrieval (keyless, in-memory)
        |
        v
/api/chat (Next.js)         agent loop, streamed over SSE
        |    events: text, tool, tool_result, cached, done, error
        |    guardrails: 5 req/min + 30 req/day per IP, 800 LLM calls/day global,
        |                standalone exact-question cache (15-minute TTL)
        v
Groq openai/gpt-oss-120b    primary free provider (MOCK_LLM=1 -> deterministic mock)
Gemini gemini-2.5-flash-lite     optional fallback when GEMINI_API_KEY is set and Groq fails
```

## MCP server

`mcp/server.ts` exposes the project's tool definitions over MCP stdio, reusing
`TOOL_SPECS` from `lib/tools.ts` verbatim (schemas passed through unchanged;
currently all six tools, including `search_docs`). Every tool is a
deterministic, read-only lookup with no model call. Point a client at an
absolute path so the server runs from any working directory:

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

`npm run mcp` (tsx) starts the same server for interactive use, but npm's
script banner is written to stdout and would pollute the protocol stream;
clients should spawn the command above instead. Stdout then carries protocol
JSON only, and diagnostics go to stderr.

## Docs search (`search_docs`)

The sixth agent tool answers questions about the project, its data pipeline,
and the hmb-v1 estimate from the project's own documentation (README.md plus
docs/DATA.md, docs/DEMO.md, docs/PLAN.md). Retrieval is deterministic and
keyless: `lib/embed.ts` is a pure hash encoder (256 dimensions, FNV-1a over
word unigrams and character 4-grams, L2-normalized) and `lib/rag.ts` ranks the
indexed passages by cosine similarity. This is a lexical hash embedding, not a
learned or semantic embedding model; results include their similarity scores.
The index lives in `data/docs_index.json` and is generated by
`npm run embed:docs` (markdown-heading sections split into ~800-character windows with
100 characters of overlap; each window is embedded with its section heading
prefixed, while the stored text is unchanged). The generated index is tracked
like `data/listings.json`: regenerate it after editing README.md or
docs/{DATA,DEMO,PLAN}.md and commit it alongside those changes. `lib/rag.ts`
imports the index at runtime, so tests and the build need it to exist; the
generator imports only the pure encoder, so `npm run embed:docs` also works
when the index is missing. Statistics questions still use the data tools.

## Optional pgvector demo

`docker-compose.yml` plus `npm run seed:pgvector` is a local-only demo of the
same embeddings in Postgres; the app never uses a database and stays keyless
and in-memory. `docker compose up -d` starts `pgvector/pgvector:pg17`, and
`npm run seed:pgvector` loads `data/docs_index.json` into a `docs_embeddings`
table (`vector(256)`); `npm run seed:pgvector -- --query "discount estimate"`
also prints the top 3 passages by cosine distance. `DATABASE_URL` defaults to
`postgres://postgres:postgres@localhost:5432/agent`. This is a demo, not the
production retrieval path.

## Optional Langfuse tracing

Tracing is off unless `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set
(`LANGFUSE_BASE_URL` overrides the endpoint). When enabled, each chat turn
emits one trace (`chat_turn`: `durationMs`, `cached`, `tools`, `errorCode`)
plus one span per tool call (name and `durationMs`). Only that metadata leaves
the process: messages, answers, tool arguments, and IPs are never sent. When
disabled the SDK is not imported and tracing is a no-op; tracing failures are
swallowed and can never affect a request.

## Project layout

```
canadian-housing-agent/
├── README.md
├── mcp/                      MCP stdio server reusing TOOL_SPECS (read-only)
├── scripts/                  embed_docs.ts (docs index), seed_pgvector.ts (optional demo), canada_refresh.sh, build_geography.py
├── docs/
│   ├── PLAN.md               milestones, constraints, known risks
│   ├── DATA.md               dataset fields, filters, limitations, terms
│   └── DEMO.md               2-3 minute demo run-through
├── pipeline/                 Python data build; stdlib unittest coverage
├── data/                     generated listings.json + market_summary.json + docs_index.json
├── lib/                      tools.ts, embed.ts (pure encoder), rag.ts, agent.ts (tool loop), dataset.ts, providers.ts (Groq/Gemini/mock), guards.ts, observability.ts, langfuse.ts
├── app/                      Next.js app: /api/chat SSE route, /api/listings JSON+CSV route, atlas UI
├── components/               atlas and chat UI components (DataTable.tsx backs the Data tab)
├── tests/                    vitest: tools, agent, guards, cache route, listings route, providers, observability, rag, mcp, langfuse, eval scoring
└── evals/                    48 golden cases + run.ts harness (npm run evals; report.json gitignored)
```

## Documentation

- [docs/STATUS.md](docs/STATUS.md): latest verified state, fixes, and next steps.
- [docs/PLAN.md](docs/PLAN.md): architecture details, milestones, constraints.
- [docs/DATA.md](docs/DATA.md): what the dataset contains and how to refresh it.
- [docs/DEMO.md](docs/DEMO.md): 2-3 minute demo run-through.

## Disclaimers

- The dataset is a research sample of public for-sale listing data (Zillow).
  It includes each listing's address and a link to the source listing; listing
  ids, agent names, and scraped source pages are not published. Not affiliated
  with Zillow.
- Asking prices only; no sold prices. Square footage covers 56.7% of rows and is
  city-skewed (near complete in Calgary, Surrey, and Vancouver; about 1% in
  Toronto and nearly none in Ottawa); values outside a plausible 200-20,000 sqft
  range (for example, land listings whose acreage the source renders as interior
  square feet) are treated as missing. The sample is a single snapshot and can be
  stale.
- `estValue`/`discountPct` estimate the typical asking price from comparable
  asking prices — not an appraisal, not sold prices, not investment advice. They
  use no property type, condition, lot, or sold data and are null for listings in
  cities with fewer than 30 rows. Estimates typically err by about ±19%, shown
  per city in the UI; deal lists only show discounts between 20% and 60%, and
  bigger gaps are treated as model artefacts, not deals.
- Nothing here is financial, legal, or real-estate advice.
- The demo runs on free tiers: Groq for the model and Vercel Hobby for hosting.
  Exhausting the daily free-tier token quota can make it unavailable during
  traffic spikes.

## License

PolyForm Noncommercial 1.0.0: free for personal, research, and other
noncommercial use; commercial use requires permission. This is a research
project built on a sample of public listing data. See [LICENSE](LICENSE).
