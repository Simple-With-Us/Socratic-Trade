# Multi-signal regime severity scorer (MONET risk lane 1/5)

**Date:** 2026-07-05
**Seat/lane:** MONET (risk engine) — first of the 5 handed-back risk lanes
**Branch:** `monet/multi-signal-regime-scorer`

## Summary

New continuous regime-**severity** scorer that blends multiple stress signals into one `[0,1]` read,
extending the coarse per-bucket `MARKET_REGIME_SEVERITY` in `market-regime.ts`. **Advisory-first and
default-OFF** — it rides into the Bull/Bear prompt as context and is audited every run, but only
influences a cap when the owner explicitly opts in.

- **New module `src/lib/regime-severity.ts`:** `scoreRegimeSeverity(inputs)` blends VIX, the VIX term
  structure (VIX/VIX3M), the HY credit spread, the 2s10s curve, and market breadth via weighted,
  documented `[0,1]` ramps → `{ severity, regime, subScores, degraded, … }`. `bucketFromSeverity`
  (exported) maps severity to a `MarketRegime` with inclusive lower edges (0.75 crisis / 0.5 risk-off /
  0.28 cautious-inverted / <0.1 risk-on-with-breadth). `applyRegimeHysteresis` prevents a one-tick
  VIX head-fake from flipping the consumed regime.
- **Money-path invariant (parity with `market-regime.ts` "unknown ⇒ severity 0"):** every signal is
  optional; missing signals are dropped and the remaining weights renormalized. Below a minimum signal
  count the read is marked `degraded` and falls back to the coarse `baseRegime` severity — a thin/absent
  feed can **never** read as a confident high-severity regime.

## Integration (all additive; default-OFF)

- **`strategy.ts` (`proposeTrades`):** scores severity once at the existing macro/breadth assembly seam
  (**zero new network calls** — every input is already fetched for the prompt), audits it
  (`regime_severity_scored`), injects it as **advisory** prompt context (exactly like `macroDerived`/
  `marketInternals` — it cannot block anything), and threads it back to `runStrategyOnce` →
  `evaluateTradeProposal`'s `PolicyContext`.
- **`policy.ts` (`deRiskInCrisisReason`):** an **opt-in, default-OFF** continuous taper on the *existing*
  `tuning.crisisMaxOpeningExposurePct` cap. `taperedCrisisCap` returns the cap **byte-identically** unless
  `riskRules.severityTaperEnabled === true` AND a non-degraded, finite severity is present. When on:
  `effectiveCap = max(floor, min(cap, cap * (1 − k·clamp(severity,0,1))))` — it can only ever **tighten**
  the same already-opt-in, already-overridable cap (never loosen — negative slope is clamped by `min(cap,…)`;
  never below `floor`; never a new gate). The tapered block reason stays escalatable (routes through the
  same `autonomyOverride` path as the binary cap).
- **`types.ts` (`RiskRules`):** `severityTaperEnabled?` (default false), `severityTaperSlope?` (default 0.5),
  `severityTaperFloorPct?` (default 0) — all opt-in.

**Off by default ⇒ behavior is byte-identical to before this lane existed** (the binary crisis cap alone
governs; the severity is scored + audited + shown to the LLM but changes no gate).

## Verification

- `npx tsc --noEmit` clean; `npm run lint` 0 errors; full Vitest suite green; `npm run build` ok.
- `test/regime-severity.test.ts`: signal ramps, weighted blend, degraded/missing-feed fallback, hysteresis,
  and `bucketFromSeverity` edge-inclusivity pinned with **exact** severities (the end-to-end blend can only
  hit a band edge float-approximately, so edge inclusivity is tested on the pure bucketer directly).

## Follow-ups

- The `RegimeSeverityResult` type is now available for the **vol-targeting** lane to optionally feed a
  continuous `targetDailyVol` taper (deferred there as out-of-scope for its v1 cut) — a follow-up, not a
  dependency.
- Owner can enable the crisis-cap taper per-account via `riskRules.severityTaperEnabled` once they want it.
