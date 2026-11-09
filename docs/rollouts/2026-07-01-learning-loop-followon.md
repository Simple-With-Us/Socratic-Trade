# 2026-07-01 — Learning-loop follow-on: unified mutation ledger + paired-t OOS gate + fail-closed config guard

Branch: `agent/claude-followon-b-learning` (forked off freshly-merged `origin/main`; Workstream B PR #296
already merged). Owner: Claude Code.

## Summary

A focused follow-on pass on the learning-loop expansion backlog
(`docs/reviews/2026-07-01-learning-loop-expansion.md`). It adds three guardrail items on top of #296's
autonomous factor-weight tuning, without re-scoping B1–B8:

1. **P0-4 — Unified learning-mutation ledger + one-click admin revert.**
2. **P0-2 — Effect-size + paired-t significance on the OOS gate.**
3. **P0-3 — Fail-closed tuning-config invariant guard.**

The through-line is making #296's autonomous weight writer safer and auditable: every autonomous mutation
now lands in ONE canonical ledger with a single revert path; the OOS gate can require a proper paired-t
significance (not just a point-estimate margin); and a bad tuning config now fails CLOSED instead of applying.

## Why

- #296 made `proposeStrategyTuning` the first autonomous writer of `policy.scoringWeights`. The expansion
  panel flagged the residual holes: (a) the audited revert was tuning-specific and hand-rolled — a second
  future auto-tuner would build a parallel one (P0-4); (b) the autonomous gate's IC-delta was a bare
  point-estimate with no significance test on the correlated per-fold ICs (P0-2); (c) an invalid tuning
  config (e.g. autonomy on while unvalidated weight moves are KEPT) could still apply (P0-3).

## What changed

### P0-4 — Unified learning-mutation ledger + admin revert
- **New table** `learning_mutations` in `src/lib/db.ts` `migrate()` (append-only; columns: id, user_id,
  connected_account_id, subsystem, trigger, run_id, flag, before_state, after_state, evidence, reverted_at,
  reverted_by, created_at; index on `(user_id, connected_account_id, subsystem, created_at)`).
- **New CRUD module** `src/lib/db-learning-ledger.ts` (module-per-concern): `insertLearningMutation`,
  `latestLearningMutation`, `listLearningMutations`, `getLearningMutationById`,
  `markLearningMutationReverted`. Re-exported from the `db.ts` barrel (`export * from "./db-learning-ledger"`).
- **New orchestration module** `src/lib/learning-ledger.ts`: `recordLearningMutation({ subsystem, userId,
  connectedAccountId, trigger, flag, before, after, evidence })` (passive/always-on) and
  `revertLearningMutation({ subsystem, userId, connectedAccountId, entryId?, revertedBy? })` — restores the
  prior `scoringWeights` vector via `setPolicy` ONLY (never a bespoke writer, so `account_strategy_state` +
  the active-profile mirror stay in sync), marks the row reverted. Subsystem constant
  `LEARNING_SUBSYSTEM_SCORING_WEIGHTS = "scoring_weights"`.
- **Generalized #296's revert (did NOT duplicate):** `applyAutonomousWeightTuning` now (i) captures `before`
  ATOMICALLY (re-reads effective policy immediately before `setPolicy`), (ii) records ONE ledger row, and
  (iii) still writes the legacy `auto_weight_apply` audit row for dashboard/prior-test back-compat.
  `revertAutonomousWeightTuning` now delegates to the unified ledger, falling back to the legacy audit-row
  snapshot only for pre-ledger applies.
- **Admin revert route** `app/api/admin/learning-ledger/route.ts` — `requireAdmin`-gated (this repo has prior
  IDOR history). `GET` lists recent ledger entries (scoped to the caller's active account); `POST { entryId?,
  subsystem? }` reverts a specific row or the most-recent non-reverted row for the subsystem.

### P0-2 — Effect-size + paired-t significance on the OOS gate
- **New pure fn** `pairedICDiffStats(observations, candidateWeights, baselineWeights)` in `src/lib/backtest.ts`
  → `{ n, meanDiff, stdDiff, seDiff, tStat }`. Computes the PAIRED per-date (candidateIC − baselineIC) series
  on the SAME fold; only dates yielding a finite IC for BOTH vectors contribute a paired point. This is the
  correct SE basis because the two ICs are correlated (shared fold) — NOT a difference of independent ICIRs.
  Returns `tStat = 0` when the paired variance is exactly zero (a t-stat is undefined there).
- **`OOSResult.pairedICDiff`** populated by `runWalkForwardOOS` when both candidate + baseline weights are
  supplied.
- **Gate extension** in `applyAutonomousWeightTuning`: `autonomousOosThresholds(policy.tuning)` now reads
  `policy.tuning.minOosICImprovement` (default 0 → today's env-`AUTO_TUNE_MIN_IC_DELTA` margin) and
  `policy.tuning.minOosPairedTStat` (default 0 = paired-t OFF / no-op). The gate now also requires
  `pairedN ≥ 2 && pairedT ≥ minOosPairedTStat` when the threshold is positive.
- **Multiplicity (D-1) explicitly deferred** — documented inline; no teeth until a per-account trial counter
  exists, and with the paired-t defaulting to 0 there is nothing to correct today.

### P0-3 — Fail-closed tuning-config invariant guard
- **New pure module** `src/lib/tuning-invariants.ts` (`validateTuningInvariants(tuning) → { ok, violations }`).
  Checks a small hard-coupling set: positive sample gates (`minClosedLotsForWeightShift`, `shrinkPrior`,
  `recurringFactorMinCount`); `sizingFloorPct ≤ sizingCeilingPct`; `autoApplyWeights ⇒ oosWithholdUnvalidated`
  (unless the new `autoApplyOverrideUnvalidated` escape hatch); `calibrationSizing ⇒ positive band gate`.
  NEVER throws.
- **Autonomous path fails CLOSED:** `applyAutonomousWeightTuning` calls it at the TOP; on any violation it
  SKIPS the apply, writes an `auto_weight_apply_skipped` audit row, and returns
  `{ applied: false, reason: "invariant_violation(...)" }` — never throws (a throw would wedge the scheduler
  tick).
- **Manual path warns, never blocks:** `app/api/strategy/tune/route.ts` attaches non-blocking
  `tuningConfigWarnings` to the proposal response.

### Types
- `src/lib/types.ts` `TuningSettings`: added `minOosICImprovement?`, `minOosPairedTStat?`,
  `autoApplyOverrideUnvalidated?` — all default to preserving current behavior.

## Files touched

- `src/lib/db.ts` — `learning_mutations` CREATE TABLE + index in `migrate()`; barrel re-export.
- `src/lib/db-learning-ledger.ts` — NEW (CRUD).
- `src/lib/learning-ledger.ts` — NEW (record + revert orchestration).
- `src/lib/tuning-invariants.ts` — NEW (pure validator).
- `src/lib/backtest.ts` — `pairedICDiffStats()` + `PairedICDiffStats` type + `OOSResult.pairedICDiff`.
- `src/lib/strategy-tuning.ts` — invariant guard (fail-closed), paired-t gate, ledger recording,
  atomic `before` capture, `autonomousOosThresholds(tuning)`, unified-ledger-first revert.
- `src/lib/types.ts` — 3 new `TuningSettings` flags.
- `app/api/admin/learning-ledger/route.ts` — NEW (admin GET/POST revert route).
- `app/api/strategy/tune/route.ts` — non-blocking `tuningConfigWarnings`.
- `test/backtest.test.ts` — `pairedICDiffStats` describe block (4 cases).
- `test/learning-loop-followon.test.ts` — NEW (P0-2 threshold plumbing, P0-3 pure + fail-closed, P0-4
  ledger record/revert/idempotency/scoping/list).
- Docs: `STATUS.md`, `PLAN.md`, `docs/phase-7-strategy.md`, this rollout note.

## Verification

Ran in the required order:

```
npx tsc --noEmit    # clean
npm run lint        # 0 errors, 265 grandfathered warnings (none from new files)
npm test            # 182 files / 1793 tests, all pass
npm run build       # <see below>
```

- `npx tsc --noEmit`: clean (after fixing a template-literal backtick in a SQL comment, and dropping a
  `ConnectedAccount.scoringWeights` assertion that doesn't exist on that type).
- `npm run lint`: 0 errors; the 265 warnings are the pre-existing grandfathered `no-explicit-any` /
  `react-hooks` backlog; none originate from the new files.
- `npm test`: 1793 passed (was 1734 pre-change; +59 from the new tests). The existing
  `test/learning-loop-autotuning-db.test.ts` revert test still passes via the legacy audit-row fallback.
- `npm run build`: see the STATUS.md line for the recorded result.

## Follow-ups / deferred (not implemented this pass)

- **D-1 multiplicity correction** on repeated auto-applies (Šidák-adjusted paired-t) — deferred; needs a
  per-account trial counter first. Documented inline in `applyAutonomousWeightTuning`.
- **P0-2 end-to-end network OOS test** — the paired-t LOGIC is unit-tested (`pairedICDiffStats`) and the
  THRESHOLD plumbing is unit-tested (`autonomousOosThresholds`); a full `applyAutonomousWeightTuning` run
  that exercises the gate needs seeded closed lots + `signal_snapshot`s + a mocked OHLC fetcher (heavy). Not
  added — the composed gate boolean is straightforward given the two tested pieces.
- **P1-1 dry-run harness, P1-2 purged/embargoed split, and the rest of the P1/P2 backlog** — out of scope
  for this focused pass.
- The admin ledger route has no UI yet (API only) — a dashboard surface is a natural next step.

## Codex review fixes (PR #300, 2026-07-01)

The PR's Codex auto-reviewer left 8 P2 findings (all valid, several safety-relevant). Fixed on top of the
original branch; verify quartet re-run green (tsc clean, lint 0 errors, 194 files / 1947 tests, build
compiled). Each finding + fix:

1. **`shrinkPrior=0` wrongly invalid** (`tuning-invariants.ts`). `resolveShrinkPrior` accepts `v >= 0` (0 =
   "no shrinkage"), but the invariant treated 0 as invalid → the autonomous path failed closed on a valid
   config. Now only a NEGATIVE `shrinkPrior` is flagged (`shrink_prior_negative`); `minClosedLotsForWeightShift`
   / `recurringFactorMinCount` remain strictly-positive.
2. **Legacy revert fallback clobbering later manual changes** (`strategy-tuning.ts`). After a ledger revert
   marked the row reverted, a 2nd `revertAutonomousWeightTuning` found no unreverted ledger row and fell
   through to the STALE legacy `auto_weight_apply` audit snapshot, restoring old `previousWeights` over any
   manual change made since. Now the legacy fallback runs ONLY for a genuine pre-ledger apply (NO
   `learning_mutations` row exists at all for this user/account/subsystem); otherwise it returns
   `no_unreverted_ledger_mutation` and touches nothing.
3. **Manual tune warnings invisible** (`app/api/strategy/tune/route.ts`). The dashboard renders
   `proposal.cautions`, but warnings were returned only in a separate `tuningConfigWarnings` field. Now the
   violations are ALSO appended into `cautions` (prefixed `Tuning-config warning: …`) so manual users see
   them; the structured field is kept for programmatic callers. (Backend only — no UI edits.)
4. **Override not runtime-validated** (`tuning-invariants.ts`). A truthy non-boolean
   `autoApplyOverrideUnvalidated` (e.g. the JSON string `"false"`) bypassed the fail-closed guard. Now
   requires `=== true` (the real boolean) to clear the violation.
5. **Cross-account `entryId` revert** (`learning-ledger.ts`). The `entryId` path looked up by `(id, userId)`
   then restored whichever account was on the row; a stale/copied id from ANOTHER account could mutate that
   other account. Now rejects rows whose `connectedAccountId` != the requested active account
   (`account_mismatch`).
6. **Non-latest `entryId` revert discards a newer mutation** (`learning-ledger.ts`). Reverting an older
   `entryId` while a newer unreverted row existed for the same account/subsystem silently discarded the newer
   mutation. Now rejects any non-latest `entryId` revert (`not_latest_mutation`).
7. **Uniform positive zero-variance diff rejected** (`backtest.ts`). When every OOS date had the SAME positive
   candidate−baseline IC diff, `seDiff=0` forced `tStat=0`, rejecting a candidate that UNIFORMLY beats
   baseline. Now a zero-variance diff returns `±Infinity` (sign of the mean) when the mean is nonzero, and 0
   only when the mean is truly 0 — so a uniformly-better candidate clears any finite paired-t threshold.
8. **Ledger missing from deletion purges** (`db.ts` consumers). `learning_mutations` was absent from both
   cleanup paths. Added it to `deleteConnectedAccount`'s per-account purge (by `connected_account_id`,
   `src/lib/db-api-keys.ts`) and to `DELETE_TABLES_BY_USER_ID` (full user deletion by `user_id`,
   `src/lib/account-deletion.ts`).

Tests added/extended: `test/learning-loop-followon.test.ts` (findings 1, 2, 4, 5, 6 — non-boolean override,
account-mismatch, non-latest, no-clobber-after-ledger-revert, genuine-pre-ledger fallback still works),
`test/backtest.test.ts` (finding 7 — uniform ±zero-variance diff → ±Infinity), `test/account-delete-cleanup.test.ts`
(finding 8 — account deletion purges ledger rows). Default-off/no-op semantics preserved throughout.
