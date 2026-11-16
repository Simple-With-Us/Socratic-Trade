# 2026-07-04 - w1-learning-loops

Branch `claude/w1-learning-loops`. One of four Wave-1 quick-win lanes off the composite expert
review at `20260704compositeexpertreview.md` (§A, lines 37-161). Scope: three specific items —
Bear-veto counterfactuals + red-team efficacy scorecard, re-indexing decision memory on lifecycle
updates, and trading-day (not calendar-day) horizon arithmetic. Nothing else from the review was
touched.

## Summary

1. **Bear-veto counterfactuals + red-team efficacy scorecard** (`src/lib/strategy.ts`,
   `src/lib/performance.ts`). The Bear (Red Team) reject branch in `runStrategyOnce` (formerly a
   bare `continue`) now calls `recordRejectedProposalCounterfactual` for opening (`buy`/`short`)
   proposals — the exact same counterfactual pipeline policy blocks (`~strategy.ts:1010`, pre-existing)
   and human rejections (`rejectProposal`, pre-existing) already use — so a Bear veto's post-veto
   return matures into missed-opportunity analytics instead of vanishing. The
   `proposal_rejected_by_red_team` audit event is now stamped with `runId` and `model` (previously
   only `symbol`/`side`/`thesisTag`/`reason`) so a veto can be joined to its matured counterfactual
   row. New `getRedTeamEfficacy()` in `performance.ts` joins those audit events to
   `skipped_candidate_counterfactuals` rows (via the shared `runId+symbol` key) and reports: total
   vetoes, matured-coverage %, veto value-add rate (vetoed trade would have lost — the Bear helped),
   survivor-risk hit rate (vetoed trade would have won — the Bear missed a winner), average
   counterfactual return, and a per-model breakdown. Read-only/advisory; gates nothing.

2. **Re-index decision memory on lifecycle updates** (`src/lib/db-socratic.ts`).
   `appendSocraticDecisionCoachNote` now re-calls `indexSocraticDecisionMemory` after appending the
   note, so the vector-memory case doc is no longer frozen at "coach_notes: none" from its original
   creation-time index (`strategy.ts`'s `recordSocraticDecision`, unchanged). The stable
   `id`/`dedupKeyPrefix: "socratic-decision"` makes this an in-place upsert, not a duplicate vector.
   Implemented via a dynamic `import("./socratic-memory")` inside `db-socratic.ts` to avoid a module
   cycle (`db-socratic.ts` is re-exported from the `db.ts` barrel; `socratic-memory.ts` dynamically
   imports `vector-db.ts`, which statically imports `./db`).
   **Scope note:** the review item also asks for re-indexing after "outcome writes" and "lesson
   writes". Neither of those lifecycle-mutation paths exists yet in this codebase — `outcome` is set
   once at case creation and `lessons` are static templates written at creation
   (`socratic-runtime.ts:375-379`); building the actual outcome/lesson writers is a separate,
   larger, unassigned effort (see the composite review's "Build the outcome writer" and "Real
   per-decision lessons at maturation" items). Only the one lifecycle-update path that currently
   exists — coach-note append — was wired here. When the outcome/lesson writers land, they should
   call `indexSocraticDecisionMemory` the same way.

3. **Trading-day horizon arithmetic** (`src/lib/market-calendar.ts`, `src/lib/counterfactual-learning.ts`,
   `src/lib/backtest.ts`). New shared `addTradingDays(dateStr, horizonDays)` in `market-calendar.ts`
   walks forward exactly `horizonDays` TRADING sessions (honoring `isTradingDay` — weekends + NYSE
   full-close holidays), anchored at UTC noon (not midnight, which rolls back into the prior NY
   calendar day since NY is always behind UTC). Both `counterfactual-learning.ts`'s and
   `backtest.ts`'s `targetBusinessDate` helpers (previously `snapshotDate + horizonDays * 86_400_000`
   ms of CALENDAR time under a "business date" name) now delegate to it.

## Why

- **Item 1**: the Bear can veto any high-conviction proposal but was the one rejection path with
  zero downstream measurement — no rejection rate, no value-add/harm accounting, no per-model
  comparison. Mirroring the existing policy-block/human-rejection counterfactual wiring closes that
  gap with an established, already-tested pattern rather than a new one.
- **Item 2**: a coaching note that never reaches the vector memory the agent actually retrieves from
  is exactly the "chat history that doesn't change behavior" failure mode the product rejects. The
  fix is minimal because the indexer, dedup key, and case id were already designed for in-place
  overwrite — it was just never re-invoked after the first write.
- **Item 3**: `snapshotDate + N * 86_400_000ms` silently assumes every day is a trading day. A Friday
  snapshot matures after only 3 real trading sessions (Sat/Sun absorbed into the horizon) while a
  Monday snapshot matures after the full 5 — weekday-dependent noise feeding directly into every
  downstream IC/counterfactual-return metric the tuner and Results page read.

## Files

- `src/lib/market-calendar.ts` — new `addTradingDays()`.
- `src/lib/counterfactual-learning.ts` — `targetBusinessDate` delegates to `addTradingDays`.
- `src/lib/backtest.ts` — `targetBusinessDate` delegates to `addTradingDays`.
- `src/lib/strategy.ts` — Bear-reject branch records the counterfactual candidate; audit payload
  gains `runId`/`model`.
- `src/lib/performance.ts` — new `getRedTeamEfficacy()` + `RedTeamEfficacy`/`RedTeamVetoRecord` types.
- `src/lib/db-socratic.ts` — `appendSocraticDecisionCoachNote` re-indexes after the append.
- `test/backtest.test.ts` — `isPointInTimeForwardExit` fixtures updated for the trading-day target
  (2026-01-05 + 5 trading days = 2026-01-12, not the old calendar-day 2026-01-10).
- `test/counterfactual-learning.test.ts` — mock OHLC bar dates + expected `exitDate` updated for the
  trading-day target (2026-06-10 + 5 trading days = 2026-06-17, not 2026-06-15).
- `test/performance.test.ts` — two new `getRedTeamEfficacy` unit tests (per-model join + matured
  coverage; short-side sign adjustment).
- `test/strategy-money-path-f-g.test.ts` — extended the existing Bear-veto end-to-end test to assert
  `runId`/`model` on the audit payload and that `getRedTeamEfficacy` sees the veto.
- `test/socratic-db.test.ts` — mocks `vector-db.storeContexts`, asserts a coached case's re-indexed
  vector text contains the coach note (uses `vi.waitFor` to await the fire-and-forget dynamic-import
  re-index rather than a fixed number of microtask flushes — a fixed-flush-count version was flaky in
  isolation even though it happened to pass inside the full suite run).
- `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md`, `STATUS.md` — lane status updated.

## Verification

Run sequentially (not concurrently — running `npm test` and `npm run build` at the same time in the
same worktree produced one resource-contention flake in an unrelated pre-existing test; every
sequential run was clean):

- `npm run lint` — 0 errors, pre-existing warning backlog only (grandfathered `no-explicit-any` /
  `set-state-in-effect`, unrelated to this change).
- `npx tsc --noEmit` — clean (ran after `npm run build` regenerated `.next/types`).
- `npm test` — **245 files / 2377 tests passed** (base was 2375; +2 net new from the
  `getRedTeamEfficacy` unit tests — other assertions were added to existing `it` blocks).
- `npm run build` — succeeded.

`next-env.d.ts` gets rewritten by `npm run build` (`.next/dev/types` <-> `.next/types` path) as an
unrelated build-artifact side effect; reverted before committing since it isn't part of this change.

## Follow-ups

- **Console/Results UI wiring for `getRedTeamEfficacy()`** is explicitly left for the console lane —
  `PerformanceSummary` (`src/lib/types.ts`) doesn't currently carry calibration/factor-scorecard-style
  advisory data either, so this follows the existing precedent of API/db-level-only functions awaiting
  a dedicated UI surface.
- **Outcome writer + lesson writer** (composite review items "Build the outcome writer" / "Real
  per-decision lessons at maturation") don't exist yet; once built, they should call
  `indexSocraticDecisionMemory` after each write, following the same pattern used here for coach
  notes.
- **Historical discontinuity**: switching `targetBusinessDate` from calendar-day to trading-day
  arithmetic changes the resolved target date (and therefore the resolved exit bar / realized return)
  for any already-materialized `skipped_candidate_counterfactuals` row or `signal_snapshot`-derived
  `FactorObservation` whose snapshot fell on a Thursday or Friday (or straddled a holiday) — rows
  already marked `matured` are NOT retroactively recomputed by this change (only future
  materializations use the new arithmetic), so historical IC/missed-opportunity numbers computed
  before vs. after this lands are not perfectly apples-to-apples for those snapshot weekdays. This
  matches the review's own framing of it as a "one-time discontinuity" to note, not backfill.
- `strategy.ts` is shared scope across the Wave-1 lanes; this lane only touched the Bear-reject branch
  (~line 681-705) and the audit-payload literal on that same line. No other lane's region was touched.

## Codex review fixes (2026-07-04, second review pass on PR #365)

Three verified P2 findings from the Codex bot review, each fixed at the root
(commit `b971b66`):

1. **Market-day horizon anchoring** (`counterfactual-learning.ts`, `backtest.ts`,
   new `market-calendar.marketDateOf`): `targetBusinessDate` derived the snapshot
   date via `toISOString().slice(0, 10)` — the UTC day — so an after-hours ET
   veto (Mon 19:30 ET = Tue 00:30Z) counted trading sessions from Tuesday and
   matured one session late. `marketDateOf` resolves the America/New_York
   calendar date for timestamps and passes date-only strings through unchanged
   (UTC-midnight parsing would have shifted those a day BACK). `backtest.ts`'s
   `parseSnapshot` gets the same fix; bar dates deliberately keep `toBusinessDay`
   (daily-OHLC bar times at UTC midnight ARE the date).
2. **Kind-scoped, keyed efficacy joins** (`performance.ts`, `db-learning.ts`):
   `getRedTeamEfficacy` scanned the all-kind audit feed (LIMIT before kind
   filter — other-kind floods could evict veto history) and joined against a
   `return_pct DESC` top slice (could drop exactly the avoided-loss rows
   `vetoValueAddRate` counts). Now: new `listAuditByKind` (LIMIT after kind
   filter; account-scoped queries include legacy user-wide rows) + new
   `getMaturedSkippedCounterfactualByRunSymbol` keyed lookups. Exit-side vetoes
   (sell/cover) are excluded from `totalVetoes` (no counterfactual is ever
   recorded for them — they could never mature and only depressed coverage).
   The strategy's veto audit now stamps `connectedAccountId` (account-scoped in
   multi-account runs).
3. **Evidence backfill instead of preemption** (`db-learning.ts`):
   `insertSkippedCounterfactualCandidate` was pure `INSERT OR IGNORE`, so the
   Bear-veto early insert (regime only) permanently blocked the run's later,
   richer `signal_snapshot` insert for the same `(runId, symbol, horizon)` key —
   the matured row lost the score/sector/dominant-factor/bulletin evidence that
   missed-opportunity analytics and tuning read. The insert now backfills ONLY
   NULL evidence columns on an existing row: first write stays authoritative for
   pricing/snapshot/status, existing evidence is never overwritten, and the
   "inserted" boolean still reports false (no double-count).

Verification: `npm run lint` (0 errors), `npx tsc --noEmit` (clean), `npm test`
(full suite green — includes 4 new tests: after-hours market-day anchoring,
evidence backfill incl. no-repricing/no-overwrite, kind-scoped audit flood,
exit-veto exclusion), `npm run build` (green). Exact counts in the PR thread.

Deferred (noted on the review thread, not fixed here): the GENERIC
missed-opportunity path (`getSkippedCandidateReturns`) still reads a vetoed
SHORT's raw price move as a long return because `skipped_candidate_counterfactuals`
has no `side` column — the efficacy path side-adjusts, but surfacing vetoed
shorts correctly in missed-opportunity/tuning context needs a schema addition
(a good candidate to fold into the Wave-2 outcome-engine lane, which already
adds guarded ALTERs to this table).
