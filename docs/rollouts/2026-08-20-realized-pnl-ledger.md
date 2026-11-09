# 2026-08-20 — `realized-pnl-ledger`: stop truncating the ledger, and grade the whole round trip

## Context & Objective
Tranche-1 cluster from the 2026-08-18 review (issues #2916, #2943).  Accounting reads took the **oldest** N fills (`ORDER BY filled_at ASC LIMIT 500`) across ~16 call sites, so once an (account, source) passed the cap the newest fills silently vanished from P&L, open lots, tax, win rate and model stats.

**Honest framing:** the review's second round narrowed this from P1 to P2 because nobody has confirmed production has passed 500 fills for any (account, source).  The truncation is a latent bug fixed here on principle.  **Two of the findings in this cluster bite today regardless of ledger size** — see below.

## The two that bite now
1. **The tuner was learning from the account's OLDEST trades under a "recent" label.**  `recentFills` (`src/lib/strategy-tuning.ts`) took a LEADING slice of an oldest-first array in both branches, so the paid LLM review argued weight nudges from the first 20 trades ever booked.  Now `.slice(-30)` / `.slice(-20)`.
2. **A losing trade graded as a win.**  Decision grading resolved on the FIRST partial exit, so a position trimmed at a profit and closed at a loss scored as won.  Failing-first output: `expected 40 to be close to -100`.  `aggregateRoundTrip` now sums every exit against the entry; a partially-closed position stays open instead of going terminal on the first trim.

## Changes Made
- `src/lib/db-fills.ts` — `listFillEvents`'s `limit` is now optional and defaults to **unbounded** (the complete ledger, oldest-first).  A numeric limit still exists for genuine display windows and returns the **newest** N via a newest-DESC subquery.  All 16 accounting call sites use the unbounded default.
- `src/lib/performance.ts` — new exported `aggregateRoundTrip(exits, entryQuantity)`; `ClosedLot` gains an optional `quantity`; `calculatePnl` returns `unmatchedClosingFills`.
- `src/lib/tax.ts` — a covered short is realized and always **short-term** (IRC 1233: the holding period runs from the property used to close it), so a >1-year short no longer leaks into the long-term bucket.  Wash-sale flags stay long-only by construction.
- `src/lib/outcome-engine.ts` — decision grading waits for the whole round trip.
- `src/lib/strategy-tuning.ts` — the "recent" fills window is actually recent.
- `src/lib/dashboard.ts`, `strategy.ts`, `experience-memory.ts`, `robinhood-pnl-crosscheck.ts`, `app/api/llm-usage/model-stats/route.ts` — unbounded accounting reads.
- `app/console/results/page.tsx`, `src/lib/types.ts` — Realized P&L discloses `Excludes N closing fills with no opening lot on record.` when non-zero.
- Tests: `test/realized-pnl-ledger.test.ts` (new, 14 cases), `test/tax.test.ts`.

## Decisions & Trade-offs
- **Rejected the cluster plan's suggested fix.**  It proposed flipping to newest-DESC everywhere.  For a stateful FIFO replay, truncating at *either* end is wrong: cutting the tail freezes P&L (today's bug), cutting the head starts the replay mid-history so exits of older lots find no opening lot and their realized P&L vanishes instead.  The sibling `listPortfolioSnapshots` could take the DESC fix because an equity time series is not replayed statefully.
- **Unmatched closes are disclosed, not invented.**  Realized P&L still excludes them — there is no honest cost basis in this app to compute one from — but the count is shown rather than quietly omitted.  0 for a clean book, so nothing new renders.
- Ordering contract (new, load-bearing): all four query shapes break `filled_at` ties on `rowid`, and the windowed shapes reverse that tiebreak in the inner DESC pass so the outer ASC pass restores insertion order.

## Scope Honesty — 4 members deliberately NOT closed
- **`perf-11`** (win rate and `n` count partial closes, not round trips) is the big one, deliberately deferred.  `aggregateRoundTrip` is now exported and is exactly the grouping primitive it needs, but `winRate`/`averageReturn` feed `aggregateClosedLots`, which backs the thesis / regime / sector / thesis×regime / factor scorecards, the Kelly payoff split, the conviction calibration and the tuner's weight-shift gate.  Regrouping changes a widely displayed NUMBER everywhere at once, and the cluster plan itself flags the grouping key as needing a product decision.  That is the owner's call, not a slip-it-in.
- The remaining three are P2/P3 and named in the PR.

## Verification State
- `npm run lint` 0 errors (769 pre-existing warnings) · `npx tsc --noEmit` clean · `npm test` **7205 passed** / 51 skipped, 0 failures (up from 7140 — the new tests run) · `npm run build` exit 0.
- Failing-first proven per fix by reverting IN PLACE (no `git stash` — refs/stash is shared across worktrees and two agents raced on it earlier).
- Rebased onto merged #2950 with three overlaps **hand-reconciled**: `PerformanceSummary` in `types.ts` and `performance.ts` (both sides' fields kept — a textual merge would have dropped one), and the Results `BucketCard` (this disclosure now sits inside #2950's rewritten Realized-P&L block, keeping its `title` and using `SENTENCE_GAP`).
- An independent skeptic read the real diff and returned SOUND_WITH_NITS; its top item was exactly that #2950 reconciliation.

## Next Steps
- `perf-11` needs an owner decision on the grouping key before it can land.
- Reviewer follow-up outside this cluster: `src/lib/chat/orchestrator.ts` still passes raw win rate to the coach with no sample count.
