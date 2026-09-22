# Data

What the Canada Housing Agent dataset contains, how it is built, and its
limitations. For architecture and milestones, see [PLAN.md](PLAN.md).

## Source

Raw listings come from the separate `property-scraper` project, treated as
read-only here: per-region CSVs of current listings at
`../property-scraper/data/regions/<city>-<prov>/listings.csv`.

The published snapshot covers 123 cities in 11 provinces with 35,566 rows
after cleaning. A rebuild reads the newest scrape tree, so its row count
follows the scrape data and can differ from the tracked snapshot (see
[Refresh](#refresh)).
The published sample includes each listing's address and a link to the source
listing; listing ids, agent names, and scraped source pages are not published.

## Build

Run from this project's root:

```bash
python3 pipeline/build_dataset.py
```

The pipeline reads `../property-scraper/data/regions` by default. To point it at
another checkout, or write somewhere else:

```bash
python3 pipeline/build_dataset.py --source ../property-scraper/data/regions --out data
```

It writes:

- `data/listings.json`: the published sample, sorted city asc / price desc
  (province is not part of the sort key)
- `data/market_summary.json`: per-city aggregates

## What is collected

- Current for-sale asking listings.
- 123 cities in 11 provinces (every region with scraped rows; 36 zero-row
  northern regions emit nothing).
- 35,566 rows in the published snapshot after dedupe and filtering (a rebuild
  from a newer scrape tree can carry more).

## Cleaning rules

Applied during the build:

1. **Dedupe** by listing id; the newest `scraped_at` wins. The id itself is
   never written.
2. **Price floor**: keep rows with price >= $50,000.
3. **Canada only**: drop rows whose address carries no Canadian province code
   (144 US-spillover rows in this build, counted as `non-CA address`).
4. **Sane beds/baths**: drop implausible counts (bounds in
   `pipeline/build_dataset.py`).
5. **Plausible sqft**: values outside 200-20,000 sqft become `null`; the row
   is kept. They are counted as `implausible sqft (nulled)` in the filter
   report (97 in this build).
   The low tail is land acreage: for vacant-land listings the feed renders
   acreage as "N sqft lot", so the scraper extracts acreage as interior area (a
   known 50-acre Innisfil landholding arrived as `sqft` 50). The high tail is
   commercial/non-residential floor area.
6. **Extract FSA**: the Forward Sortation Area, the first three characters of
   the postal code in the address, kept only when its first letter is valid
   for the directory province (A=NL, B=NS, C=PE, E=NB, G/H/J=QC,
   K/L/M/N/P=ON, R=MB, S=SK, T=AB, V=BC, X=NT/NU, Y=YT). A mismatch becomes
   `null`; the row is kept and counted as `fsa/province mismatch (nulled)`
   (9 in this build, never a drop).
7. **Emit ten fields**: `city`, `province`, `fsa`, `price`, `beds`, `baths`,
   `sqft`, `seen`, `address`, `url`. Listing ids and agent names are not
   written; scraped source pages are not published. `province` is the
   2-letter directory-suffix code (authoritative, never parsed from the
   address); city keys stay bare (a build-time assertion fails if two slugs
   ever share a city stem across provinces).

## Fields

| Field | Notes |
| --- | --- |
| `city` | One of the covered cities (bare stem, e.g. `vancouver`). |
| `province` | 2-letter province code from the region directory (e.g. `BC`). |
| `fsa` | Forward Sortation Area, derived at build time; `null` for the 417 rows without a parseable postal code (407 of them spaceless codes such as `A1W3G6`, mostly NL; 8 in ON). |
| `price` | Asking price, as listed. |
| `beds` | Bedroom count. |
| `baths` | Bathroom count. |
| `sqft` | Interior area where the source lists it; `null` when missing or implausible (see cleaning rules). |
| `seen` | Date the source last saw the listing (ISO date). |
| `address` | Full address as listed, including city, province code and postal code. |
| `url` | Link to the source listing (https). |

Not published: listing ids, agent names, scraped source pages.

City lookups accept natural spellings (e.g. "St. Catharines", "Sault Ste. Marie") via normalization.

## CSV export

`GET /api/listings?format=csv` returns all 35,566 rows with the header
`city,province,fsa,price,beds,baths,sqft,seen,address,url`. Values are quoted per
RFC 4180 when they contain commas, quotes, or line breaks, and cells that start
with `=`, `+`, `-`, `@`, tab, or carriage return get a leading `'` so
spreadsheets treat them as text. The document is serialized once per server
process and served with a one-hour browser / one-day CDN cache.

## Square footage

`sqft` is missing for about half the rows and coverage varies by city. The
plausibility rule above nulled 97 values in the tracked snapshot. 48.1% of
kept rows carry `sqft` (17,090 of 35,566); non-null values range from 204 to
19,610.

`data/market_summary.json` reports a per-city `medianSqft` over plausible values
only, and `null` when a city has fewer than 10 sqft samples. 28 of 123 cities
fall below that bar.

## Refresh

Refresh is automated by `scripts/canada_refresh.sh`, run every 24 hours by a
launchd agent (`scripts/install_refresh_schedule.sh` installs it as
`local.canada-refresh`; log at `output/refresh.log`). The old
`local.ontario-refresh` job must be uninstalled separately (see the installer
header). It starts a scrape refresh via the scraper's
`scripts/pull_all_provinces.sh` when the newest region CSV is
older than 7 days, or when a previous run left regions unfinished
(pending/partial/challenged), at most one start per 24 hours. Once a scrape has
settled with newer CSVs it rebuilds the snapshot, runs the pipeline tests and
vitest suite, and commits and pushes only `data/listings.json` +
`data/market_summary.json` to `origin` (the owner's automation, path-scoped so
unrelated work is not committed); Vercel auto-deploys and the agent serves the
new snapshot after deploy.

Publishing waits for the next scheduled run, so the app snapshot can lag the
newest scrape date until then. The app serves the tracked files, not the live
scrape tree.

Manual fallback:

```bash
python3 pipeline/build_dataset.py --source ../property-scraper/data/regions
```

The build overwrites `data/listings.json` and `data/market_summary.json` (the
scheduled run commits them). A scrape may be interrupted by a Zillow challenge;
a human clears it in the attach Chrome and the next run resumes the queue.

## Limitations

- **Asking prices only.** No sold prices, so the data says nothing about
  transaction values or market direction.
- **Sparse square footage.** `sqft` is present for about half the rows and coverage
  is uneven by city (28 of 123 city medians are suppressed below 10 samples) and
  implausible values (lot acreage, commercial floor area) are excluded. Treat
  per-square-foot comparisons with care.
- **Single snapshot.** The current build keeps no history, so price changes and
  price cuts cannot be computed. Adding that would require snapshot archiving in
  `property-scraper` (planned).
- **Staleness.** The scheduled job publishes a settled scrape when it next
  runs, so the app can lag the newest scrape data until then; a Zillow
  challenge or an interrupted queue can leave it a few days old until a human
  clears the challenge.
- **Duplicate rows.** Dedupe is by listing id only. 870 rows still repeat another
  row on the seven non-address fields (city, FSA, price, beds, baths, sqft,
  seen) while differing in address/url, which can slightly overstate
  identical-looking segments. This is intentional.

## Terms and attribution

- Research sample of public for-sale listing data collected from Zillow. Addresses
  and source links are published; listing ids, agent names, and scraped source
  pages are not.
- Not affiliated with, endorsed by, or sponsored by Zillow.
- For informational use only. Not financial, legal, or real-estate advice.
