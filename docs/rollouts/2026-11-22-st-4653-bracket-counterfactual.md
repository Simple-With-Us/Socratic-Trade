# ST-4653 bracket exits + counterfactual side correctness (2026-11-22, Muse Code MC)

## Context & Objective
ST-4650 fleet-sweep Batch B: two learning-integrity gaps.  (A) Bracket stop/take-profit exits booked through fill reconciliation never became experience memory, because they have no app exit proposal, so risk exits were systematically absent from episodic retrieval.  (B) Skipped-candidate counterfactuals carried no order side, so a vetoed/blocked short matured with long sign wherever a read path did not compensate by hand.

## Changes Made
- `src/lib/experience-memory.ts`: `recordClosedLotExperience` is proposal-optional.  With `bracketParentOrderId`, the write requires the opening fill whose broker order id is the bracket container, a FIFO lot at that fill's entry stamp/price, and no same-stamp/price opening ambiguity; otherwise it writes nothing.  Bracket documents carry `exit_kind: bracket`, `risk_exit`, thesis `Bracket Exit`, and an accession keyed by entry proposal + closing fill id.  No proposal is synthesized.  Opening sides are guarded out even if a future caller misroutes.
- `src/lib/fill-reconciliation.ts`: after a broker-originated execution books successfully with role `exit`, a parent order id, and side sell/cover, the experience write is queued fire-and-forget.  Broker-order-id booking dedupe means replays never reach the hook twice, and experience failure cannot break booking.
- `src/lib/db.ts` + `src/lib/db-learning.ts`: new nullable `side` column on `skipped_candidate_counterfactuals` (fresh CREATE + guarded ALTER in `migrate()`), CRUD carry-through with COALESCE backfill on the insert-or-ignore path.
- `src/lib/counterfactual-learning.ts` + `src/lib/strategy.ts`: all three rejected-proposal producers pass the proposal side; only opening buy/short persist a side (rejected exits keep legacy side-less behavior, no gating change smuggled in).  Maturation side-adjusts the headline return and daily/intraday horizon rows exactly once via `sideAdjustPct`; side is carried into intraday due-job payloads.
- `src/lib/performance.ts`: `getRedTeamEfficacy` inverts only side-less legacy rows at read; side-persisted rows are already adjusted at maturation, preserving exactly one adjustment.  `getSkippedCandidateReturns` and the source-value join take `returnPct` as-is, now correctly signed.
- Tests: `test/experience-memory.test.ts` (+3 bracket cases incl. replay no-duplicate, orphan container, rejecting vector store), `test/rejected-counterfactual.test.ts`, `test/counterfactual-learning.test.ts` (short rise/fall, buy/legacy unchanged), `test/red-team-efficacy-honesty.test.ts` (no double inversion).

## Decisions & Trade-offs
- Bracket experience is skipped by design whenever the entry lot cannot be proven (no container opening fill, no lot at its stamp/price, or multiple openings sharing stamp+price).  A missing memory is honest; a guessed one would poison retrieval.
- Legacy side-less rows keep their historical long-sign maturation; only rows written with a persisted side change sign behavior, and the one compensating reader was narrowed to legacy rows so nothing double-adjusts.
- Pre-deploy intraday rows already written by due-jobs keep their long sign (`mergeHorizonRows` is existing-terminal-wins); only jobs enqueued after this change carry side.

## Verification State
- Writer lane: 11 targeted/adjacent suites, 146 tests passed; `npx tsc --noEmit` clean; eslint on touched files 0 errors.
- Parent re-ran lint/tsc/the same 11 suites/build on the harvested tree before opening the PR (see PR body for observed counts).  Full serial suite runs in CI verify.

## Next Steps & Blockers
- Shares `src/lib/experience-memory.ts` with ST-4652 (disjoint regions: closed-lot recording here vs retrieval ordering there) and a strategy.ts adjacency with #5436's reject gate; whichever lands later gets the overlap check plus combined reruns.

## Zero-Code Findings
- None.
