# Demo script (2-3 minutes)

A run-through for recording the live demo. Open
https://canadian-housing-agent.vercel.app, let the atlas load, then use the chat
panel. Ask the questions below in one chat: the follow-up depends on the
history, and a new chat starts fresh. Record when the Groq free tier has quota
left, or run locally against a key (`npm run dev`); the offline mock cannot do
budget filters or follow-ups.

Before recording:

- Check quota with one question that is not on the list (for example "Compare
  Hamilton and Kitchener"), then start a new chat. Answers are cached
  server-side for 15 minutes, so a warm-up on a scripted question would play
  back as a cache hit. Budget a minute for the atlas to settle.
- Open a second tab on the shareable Data URL, for example
  https://canadian-housing-agent.vercel.app/?city=toronto&view=data

## Questions and what each one shows

| # | Ask | Look for |
| --- | --- | --- |
| 1 | "What is the median asking price in Ottawa?" | A city snapshot: median, listing count, updated date. Expand the "How this answer was computed" block to show `city_snapshot` and the raw arguments. |
| 2 | "Show me 2-bedroom homes under $700,000 in Toronto" | Listing cards with price, beds/baths/sqft, FSA, full address, and a "View listing" link, plus the "Based on N sample listings" line. |
| 3 | "What is the median for 2-bedroom homes under $700,000 in Toronto?" | A filtered snapshot, not a search. The provenance block shows the raw `city_snapshot` arguments from the model. |
| 4 | "Which Toronto postal areas are cheapest for 2-bedroom homes?" | An area ranking from `rank_areas`: FSA, median asking price, and listing count. Only areas with 5 or more matching listings are included. |
| 5 | "Which of those areas has the most listings?" in the same chat | The follow-up reuses Toronto and the 2-bedroom filter, now ranking by listing count. History-bearing requests always reach the model, so this one is never cached. |
| 6 | "Find undervalued listings in Brampton" | A `find_deals` answer: listings asking below the comparable-listings estimate, biggest discount first, with the applied minimum discount. The provenance block shows the raw `find_deals` arguments. |
| 7 | "Should I buy now?" | A refusal in one line: no investment advice and no predictions. |
| 8 | "What were the sold prices in Toronto last month?" | A refusal: asking prices only, no sold prices or MLS numbers in the sample. |

The questions run about 100 seconds. Then show the affordances:

1. Provenance: collapse and expand "How this answer was computed" on question 1
   or 3. Each row shows the raw tool id, the raw arguments the model sent, and
   the result summary. Ask question 1 again within 15 minutes to show the
   "Cached answer" note and the block replaying unchanged.
2. Listing links: scroll the cards from question 2 and open one "View listing"
   link in a new tab, then close it.
3. Data tab: in the atlas, open Data, switch the city, and click
   "Download CSV · 50,014 rows". The file is the full published snapshot.
4. Shareable URL: change the city, sort, or price ceiling, then copy the
   address bar into the second tab. City, compare pair, sort, price ceiling,
   tab, and view are restored. Back and forward do not resync the view.

## What not to claim

- Not live MLS or a listing service. It is a research sample of public listing
  data, refreshed from periodic scrapes.
- Asking prices only. No sold prices, transaction history, or MLS numbers.
- The comparable-listings estimate is a typical-asking-price heuristic from this
  sample (median error about 19%, shown per city in the UI), not an appraisal or
  a prediction. Deal surfaces show discounts only in the 20-60% window; larger
  discounts are treated as model artefacts.
- No investment, legal, or financial advice, and no predictions.
- A single snapshot: numbers can be stale, and duplicate rows and sparse square
  footage can skew comparisons.
- Free tiers: the Groq daily token quota can take the live demo down. If it
  errors mid-recording, say so and retry later instead of working around it.
