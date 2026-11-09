# 2026-06-22 - negative-ev-skip-gate

## Summary

Added an **optional** negative-expectancy skip gate to the deterministic strategy path
(`policy.tuning.skipNegativeExpectancy`, **default OFF**). When enabled, an OPENING proposal is
**skipped entirely** (dropped before sizing — no order, no phantom fill) if its thesis is **proven**
(≥ `minClosedLotsForWeightShift` closed lots) **and** its shrunk realized average edge — already net
of the paper cost model — is at or below `skipNegativeExpectancyEdgePct` (default 0%).

- New `shouldSkipNegativeExpectancy(proposal, policy, source, userId)` in `strategy.ts` (exported,
  testable). It reuses a newly-extracted shared `selectThesisStat(regimeScorecard, thesisScorecard,
  proposal)` helper — the same thesis×regime-vs-thesis bucket selection the sizer uses — so the gate
  and the sizer always read the **same** realized edge (no drift).
- Wired as a `.filter()` before `applyDeterministicSizing` in `runStrategyOnce`; a skipped proposal
  is logged and audited (`proposal_skipped_negative_ev`).
- Exposed as a **Settings toggle** (Strategy → tuning) plus a conditional threshold field, validated
  in `app/api/policy/route.ts`.

## Why

Surfaced by the (closed) PR #89 strategy review. The cost model already nets execution cost into the
edge that drives sizing, and the normal sizer **downsizes** a negative-expectancy thesis to the 10%
exploratory floor rather than skipping — that floor is **deliberate** (keep gathering data on weak
theses). So this is *not* a bug fix; it's an **opt-in, more-conservative stance** ("don't open a
proven money-loser") for operators who want it, without changing the default behavior. Crucially it
**never** skips an UNPROVEN thesis — the exploratory floor on those is preserved exactly.

## Files

- `src/lib/types.ts` — `TuningSettings.skipNegativeExpectancy?` + `skipNegativeExpectancyEdgePct?`.
- `src/lib/strategy.ts` — `selectThesisStat` (extracted, shared), `shouldSkipNegativeExpectancy`, the pre-sizing filter + audit.
- `app/api/policy/route.ts` — validation for the two new tuning fields.
- `app/dashboard-client.tsx` — Settings toggle + conditional threshold field.
- `test/negative-ev-gate.test.ts` — NEW (9 tests): `selectThesisStat` selection; gate off/on, proven-negative skips, proven-positive + unproven + exits don't, configurable threshold.

## Verification

In `~/apps/trading-ev-gate` (branch `feat/negative-ev-skip-gate`, base `origin/main`):

- `npx tsc --noEmit` — clean (exit 0).
- `npm test` — **1007 passed** across 112 files (+9).
- `npm run build` — clean (exit 0). The Settings toggle matches the existing `Switch` pattern.

## Follow-ups

- None. Default-off keeps all existing sizing behavior; the sizer's exploratory floor and conviction
  cap are untouched.

## Blockers

- None.
