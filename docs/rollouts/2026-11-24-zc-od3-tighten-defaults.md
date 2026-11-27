# 2026-11-24 — ST-4680 OD-3 tighten-only defaults + backtest correctness (ZC)

## Context & Objective

Owner approved the OD-3 TIGHTEN-ONLY subset on Tue, Nov 24, 2026 (ST-4680, child of ST-4668).  This lane lands the defaults-plus-backtest-correctness half as one commit: tighter out-of-the-box risk defaults, a default sector cap, an honest non-overlapping backtest equity curve, and a stricter autonomous OOS gate.  The separate-decision subset (trailing stops by default, marketableLimitEntries by default, VIX severity sizing, Thompson routing, alpha grading with short calibration, FUNDAMENTALS_ASOF_STRICT with auto-apply) is NOT in scope and was not touched. autoApplyWeights stays OFF.

## Changes Made

Defaults (src/lib/defaults.ts): maxEntryDriftPct 10 -> 3, proposalExpiryMinutes 2880 -> 240 (4h), maxSymbolExposurePct 25 -> 15, tuning.earningsBlackout true (was absent = off), and a new defaultSectorCapPct: 30 key.  Every tightened value remains an adjustable preference: mergePolicy deep-merges tuning and spreads top-level keys, so an explicit stored value still wins and only policies that never set the key inherit the new default.

Default sector cap seam: the new TradingPolicy.defaultSectorCapPct (src/lib/types.ts) is consumed as the FALLBACK in both existing consumers — sectorCapFor (src/lib/policy.ts, the exposure gate) and sectorCapPctForSizing (src/lib/strategy.ts, the deterministic sizer).  Match semantics are unchanged: exact sectorCaps key first, then case-insensitive key, and only when neither matches does the fallback apply.  An explicit per-sector entry always wins, including an explicit 0.  defaultSectorCapPct 0 (or absent on a pre-ST-4680 stored policy read without merge) disables the fallback, restoring the old no-cap-unless-listed behavior.  The PUT /api/policy schema (src/lib/policy-update-schema.ts) accepts the key and the route validates it 0..100 alongside the existing sectorCaps check (app/api/policy/route.ts).  The db-profiles.ts / db.ts mergePolicy copies needed no edit: both spread DEFAULT_POLICY, so the scalar inherits automatically and the `sectorCaps ?? DEFAULT_POLICY.sectorCaps` fallback is unchanged.

Backtest correctness (src/lib/backtest.ts):
- DEFAULT_AUDIT_LIMIT 500 -> 5000 (clamp 1..5000 unchanged) so a normal daily-snapshot history can clear the tightened 20-date OOS floor.
- purgeEmbargo default false -> true in runWalkForwardOOS; explicit false restores the legacy embargo-only split.  The always-on horizonDays embargo is unchanged.
- buildEquityCurve now compounds NON-OVERLAPPING holding blocks instead of every daily cross-section.  A block entered on date d holds through the close of targetBusinessDate(d, horizonDays); any snapshot date before that exit is skipped because its forward return overlaps the open block's realized bars.  The next block enters on the first snapshot date at/after the prior exit, stepping in TRADING days (market-calendar addTradingDays), not snapshot-index space, so sparse (e.g. weekly) snapshots stay correct.  The new optional horizonDays parameter defaults to DEFAULT_HORIZON_DAYS (5); runWalkForwardOOS passes its resolved horizon into all three curve builds (main, candidate drawdown, baseline drawdown).  SPY benchmark returns compound on the SAME block dates.
- Annualization now spans first block entry through the LAST block's exit (its horizon-forward return is part of the compounded total); the old last-entry span annualized n blocks' returns over n-1 blocks' elapsed time.  Sharpe keeps (mean/std) * sqrt(252/horizonDays), which is now correct because each curve point is one non-overlapping horizon-day block (~252/h blocks/year).  The convention disclaimer and the result note were rewritten to describe the new behavior honestly; IC statistics still use every cross-section.

Autonomous OOS gate (src/lib/strategy-tuning.ts): autonomousOosThresholds minTestDates default 4 -> 20 (AUTO_TUNE_MIN_TEST_DATES env override still wins) and minPairedTStat default 0 -> 1.65 (explicit policy minOosPairedTStat still wins; 0 disables the significance gate).  The autonomous path's purgeEmbargo pass-through fallback flipped false -> true to match the new backtest default (policy.tuning.oosPurgeEmbargo explicit false still opts out). autoApplyWeights and its ?? false default are untouched.  Type docs for oosPurgeEmbargo, minOosPairedTStat, minOosTestDates, and earningsBlackout updated to the new defaults.

Files touched:
- src/lib/defaults.ts
- src/lib/types.ts
- src/lib/policy.ts
- src/lib/strategy.ts
- src/lib/policy-update-schema.ts
- app/api/policy/route.ts
- src/lib/backtest.ts
- src/lib/strategy-tuning.ts
- test/od3-tighten-defaults.test.ts (new)
- test/backtest.test.ts
- test/backtest-account-scope.test.ts
- test/learning-loop-backlog.test.ts
- test/learning-loop-followon.test.ts
- test/policy.test.ts
- test/risk-receipts.test.ts
- test/approval-limit-reprice.test.ts
- test/guard-enablement.test.ts
- test/policy-idempotence.test.ts
- test/staleness-gate.test.ts
- STATUS.md
- docs/rollouts/2026-11-24-zc-od3-tighten-defaults.md

## Decisions & Trade-offs

- Sector-cap seam: fallback INSIDE the two existing lookup helpers rather than seeding sectorCaps with entries.  Seeding would have changed the stored shape, broken the whole-replace sectorCaps merge in the strategy page, and made "explicit entry wins" ambiguous.  The fallback keeps sectorCaps {} as the default stored shape and applies the cap only at read time, so pre-ST-4680 policies inherit it through mergePolicy exactly like the 2026-07-28 guard-enablement precedent.
- Non-overlapping blocks skip overlapping cross-sections entirely (no fractional weighting).  This is the conservative, physically-honest convention: capital is in one top-K block at a time.  Idle gaps between sparse snapshots earn nothing (no return invented).  The curve is shorter than before; annualization/Sharpe were adjusted to match so the summary statistics describe the same curve.
- computeOosEvidenceCutoff needed no change: the purge shrinks only the TRAIN side; the test-fold start (the cutoff) is set by the embargo, which is unchanged.
- The strategy-tuning.ts purge pass-through fallback was flipped with the backtest default; leaving it ?? false would have made the new default dead code on the autonomous path.  This is the one strategy-tuning edit beyond the two threshold defaults, and it is covered by an updated pinning test plus a new explicit-opt-out test.
- Three staleness/idempotence fixtures (test/staleness-gate.test.ts, test/policy-idempotence.test.ts) pin maxEntryDriftPct 10 explicitly: their 9.5 -> 10 anchor (~5.3% drift) targets the stale-quote conversion, not the drift gate, so the explicit override keeps them focused.  test/guard-enablement.test.ts's exact tuning-shape pin gained earningsBlackout: true.
- P2-6 pinning test now uses a 25 policy floor with 22 test dates (above the new 20 default, below the policy floor) so it still proves the POLICY raise binds rather than accidentally passing on the default.

## Verification State

Commands run in this lane (serialized full gate is the lead's job; this box hosts production; vitest config already pins maxWorkers 1):
- npm run lint (errors-only gate)
- npx vitest run test/backtest.test.ts test/backtest-account-scope.test.ts test/policy.test.ts test/od3-tighten-defaults.test.ts test/strategy-hardening.test.ts test/risk-receipts.test.ts — 244 tests, all pass after the weekly-fixture holiday fix.
- npx vitest run test/learning-loop-backlog.test.ts test/learning-loop-followon.test.ts test/strategy-tuning.test.ts test/model-defaults-derisk-exits.test.ts test/proposal-revalidation.test.ts test/approval-limit-reprice.test.ts test/conviction-size-cap.test.ts test/ops-performance.test.ts test/guard-enablement.test.ts test/vol-targeting-sizing.test.ts test/kelly-sizing.test.ts test/thesis-size-multiplier.test.ts — 159 tests, all pass after the tuning-shape pin update.
- npx vitest run test/e2e-money-path.test.ts test/final-size-red-autonomous.test.ts test/p0-safety-fixes.test.ts test/hard-gate-classification.test.ts test/policy-idempotence.test.ts test/persistence-hardening.test.ts test/antigravity-cheap-wins.test.ts test/broker-minimum-sizing.test.ts test/broker-minimum-bump-execute.test.ts test/proposal-data-adjustments.test.ts test/quote-delayed-fallback.test.ts test/staleness-gate.test.ts test/washsale-modes.test.ts test/pdt.test.ts test/vol-targeting.test.ts test/thesis-tag-deterministic.test.ts test/market-preselection.test.ts test/protective-exit-reprice.test.ts test/exit-stop-release-approval.test.ts test/order-confirmation-status.test.ts — 323 tests, all pass after the three drift-tolerance fixture pins.
- npx vitest run test/backtest.test.ts test/guard-enablement.test.ts and test/policy-idempotence.test.ts test/staleness-gate.test.ts — re-runs of the fixed files, all pass.

NOT run here (lead runs the serialized full gate): npx tsc --noEmit, npm run build, full npm test.  The Node-22-only test/cpuprofile-summary.test.ts failure is unrelated and ignored per task instruction.

## Next Steps & Blockers

- Lead: run the serialized full gate (lint, tsc --noEmit, npm test, npm run build), then push zc/4680-od3-tighten-defaults, open the PR (Fixes ST-4680), drive Kody review + verify, and merge through the relay.
- The separate-decision OD-3 subset remains parked for its own owner decision; nothing in this commit arms it.
- No production behavior change until merge + deploy; stored policies with explicit values keep them.

## Zero-Code Findings

None beyond the implementation above; the verified map in the task brief matched origin/main a61b531789 exactly (line numbers drifted only where noted).

Note (Nov 25): the PR head also carries clean merges of `origin/main` since the review-critical commits; the behavior change surface is unchanged by them.
