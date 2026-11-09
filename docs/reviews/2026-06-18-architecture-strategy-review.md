# Strategy, architecture & LLM — review (2026-06-18)

Source: the `platform-deep-review` multi-agent workflow (architecture track: 6 dimensions). The
adversarial-verify + synthesis stages were cut off by the session limit, so this report is
reconstructed from the reviewers' findings — treat severities as reviewer-assigned and confirm
each against the code before acting. Grounded in `src/lib/strategy.ts`, `market.ts`,
`policy.ts`, `performance.ts`, `vector-db.ts`, `data-providers.ts`, `macro*.ts`,
`market-signals/*`, `db.ts`.

## Executive summary
The engine is sophisticated (deterministic scan → bull/bear LLM debate → policy gating →
paper/live execution, with a thesis/regime learning loop). The highest-value gaps cluster in
**(1) LLM interaction hygiene** (no temperature/determinism control, no max-output cap, claimed-
but-absent prompt caching, an overloaded bull prompt, overlapping bear/risk layers),
**(2) learning-loop correctness** (several scorecard/efficacy joins read mismatched keys or
weight every closed lot equally), **(3) risk-exit gaps** (proactive stop/take-profit/trailing
exits configurable but never firing, or bypassing policy), and **(4) data-layer resilience**
(error-swallowing cascades, failure-poisoned caches, single non-jittered 429 retry).

## Already fixed this session
- **`getMarketSignals` collapsed failed sources into the cache** (a reviewer finding) — fixed:
  empty/failed base results are no longer cached, breadth has its own success-only 30-min cache
  and is merged fresh, so a cold-start hiccup self-heals on the next poll instead of sticking.
  `macro-history.ts` likewise no longer caches an empty result.

## Top priorities (verify, then fix)
1. **Proactive risk exits never fire / bypass policy** — `trailingStopPct` (and possibly
   stop-loss/take-profit driven exits) are configurable but not actually enforced at runtime, or
   exit orders skip the normal policy gate. This is the highest-risk item for live trading.
2. **Learning-loop join/key bugs** — multiple findings: signal-efficacy reads the wrong
   key/source; scorecards weight every closed lot equally (no recency/size weighting);
   confidence calibration measured against the wrong bucket; auto-tuner weight gate counts the
   wrong thing; writer/reader `userId` mismatch in some persistence paths. Net effect: the
   "learning" may be learning from mis-joined data. Audit each join end-to-end.
3. **LLM determinism & cost** — no `temperature`/seed control and no max-output-token cap on
   agent calls; **prompt caching is referenced in comments but not implemented**. Add explicit
   sampling params, output caps, and real caching (or remove the claim).
4. **Bull prompt overloaded / overlapping risk layers** — the bull system prompt is very large
   (token cost + dilution), and there are three overlapping bear/risk layers; consolidate the
   risk reasoning and trim the prompt to the highest-signal evidence.
5. **Short/cover accounting** — short order notional / short exposure checks and daily-notional
   clamps need a focused audit (long-flagged high-risk area in AGENTS.md).

## RAG / vector-db
- `retrieveContext` re-embeds the query every call (cost) and fetches context only for a narrow
  case; within-symbol cosine ranking and Pinecone metadata storing full text are flagged.
- **Stale 8-K vectors are never evicted**; beyond the first 25 filings, ingestion may drop data.
- RAG is dormant without `VOYAGE_API_KEY` (expected) — but the above are real once it's on.

## Data architecture & resilience
- **Cascading enrichment swallows errors** (failures look like "no data"); add visibility.
- **Single non-jittered 429 retry** across providers — add backoff + jitter.
- **History OHLC cache keyed by symbol only** — ignores interval/range nuances.
- **Per-symbol enrichment cache** and **dead mock/fallback enrichment** paths flagged for cleanup.
- **DEFAULT_MACRO fabricated constants** — acceptable as a no-key fallback, but ensure they are
  never presented as live (they feed derived macro when `FRED_API_KEY` is unset).
- **Cold-start thundering herd**: `getDashboardSnapshot` fires ~25 FRED calls + 2×1.3MB Massive
  grouped + news per load; first loads can time out (self-heals via the new caches). Consider a
  background/scheduled macro refresh so the request path isn't a herd.

## Correctness / accounting
- Quantity-only market orders, exposure caps evaluated against the wrong base, paper projection
  vs FIFO P&L consistency, `dailyExecutionStats` argument usage, fills↔portfolio-snapshot
  consistency, and a **global single run-lock that blocks multi-user** were all flagged. Each
  needs a targeted test before trusting the numbers.

## Quick wins
- Add temperature + max-output-token to the LLM calls; implement or drop the caching claim.
- Add jittered backoff to the 429 retry path.
- Move macro/breadth/history fetches to a scheduled refresh (off the request path).
- Add a focused test per learning-loop join to pin the correct keys.

## Larger initiatives
- End-to-end audit of the learning loop (joins, weighting, calibration) with fixtures.
- Risk-exit engine that actually enforces stop/take-profit/trailing through the policy gate.
- Backtesting harness (the Massive bulk bars + S3 flat-file foundation built this session can
  feed it).
