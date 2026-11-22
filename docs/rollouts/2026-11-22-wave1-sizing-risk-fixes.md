# ST-4646 — Wave 1 Money-Path Sizing & Risk Fixes

## 1. Context & Objective

Fixes four money-path sizing and risk-control gaps surfaced in the November 2026 audit (ST-4646).  Without these fixes, LLM-advised opening notionals bypassed deterministic risk multipliers (ignoring vol-targeting, fractional Kelly, per-thesis multipliers including `0x` park, calibration sizing, conviction/degraded-data caps, and signal-health drift throttle), equal-risk and heat-budget sizing ignored concrete bracket/ATR/short stop distances and multi-proposal batch heat accumulation, Socratic override sizing ran after deterministic sizing and could upsize proposals even when `socraticOverrideMode` was `"off"`, and default Socratic override policy allowed 100%-NAV auto-executing overrides.

## 2. Changes Made

- **Deterministic risk-multiplier enforcement on LLM-advised notionals (`src/lib/strategy-risk.ts`):**
  - When `finalMultiplier <= 0` (e.g. a `0x`-parked thesis via `policy.tuning.thesisSizeMultipliers` or a proven negative-EV stop), `targetNotional` and `rawSourceNotional` both resolve to `0`, preventing `advisedNotional` from bypassing the stop and preventing `brokerMinimumDollarNotional` from bumping a `0x`-parked order back to `$1`.
  - When `advisedNotional > 0` and `finalMultiplier > 0`, `advisedNotional` is scaled by `advisedScale = Math.min(1, thesisScale * volScale * convictionScale * kellyScale)` (`Math.floor(advisedNotional * advisedScale)`) before clamping to `openingSizingCap`.
  - In the exhausted portfolio-heat branch (`remainingUsd <= 0`), `targetNotional` is capped at `Math.min(targetNotional, fallbackNotional)` instead of `Math.min(targetNotional, Math.max(fallbackNotional, taperedNotional))` so an already-trimmed order never jumps upward.
- **Equal-risk stop resolution, post-bracket heat re-assertion, and sequential multi-proposal heat accumulation (`src/lib/strategy-risk.ts`, `src/lib/strategy.ts`):**
  - Exported `resolveStopDistancePct(proposal, policy, marketScan, atrStopPctByOpeningSymbol)` and updated its priority chain to: (1) `proposal.bracketStopLoss` vs `proposal.referencePrice ?? scanQuotePrice`, (2) fallthrough to `proposal.stopPrice` vs `proposal.referencePrice` whenever tier 1 does not yield a positive distance, (3) positive finite `atrStopPctByOpeningSymbol?.[normalizeSymbol(proposal.symbol)]`, (4) side-specific configured stop (`shortStopLossPct ?? stopLossPct` for shorts, `stopLossPct` for buys), and (5) `STOP_PLAN_FALLBACK_STOP_PCT`.
  - Added optional trailing parameter `atrStopPctByOpeningSymbol?: Record<string, number>` to `applyDeterministicSizing` and unified the portfolio-heat taper's `ownStopPct` with `stopDistancePct`.
  - Extracted `applyHeatCap()` and re-asserted it after `bracketWholeShareMinimum` with freshly computed `orderRiskUsd` and `taperFactor` so a whole-share bracket bump cannot exceed the remaining portfolio heat budget, emitting `sizing_heat_budget_applied` at most once.
  - Replaced `.map(...)` in `src/lib/strategy.ts` with a sequential `for` loop that runs `applySocraticOverrideSizing` before `applyDeterministicSizing`, threads `atrStopPctByOpeningSymbol`, and updates a shallow-cloned `runningBookHeat` (`totalRiskUsd` and `heatPct`) after each sized opening proposal.
- **Socratic override mode guard (`src/lib/socratic-runtime.ts`):**
  - Added an early return `if ((policy.socraticOverrideMode ?? "off") === "off") return proposal;` at the top of `applySocraticOverrideSizing` so `"off"` mode never resizes a proposal.
- **Tightened default Socratic override policy (`src/lib/defaults.ts`):**
  - Set `DEFAULT_POLICY.socraticOverrideMode` to `"propose"` and `DEFAULT_POLICY.socraticOverrideMaxPctOfNav` to `15` while keeping `DEFAULT_RISK_RULES.drawdownBreakerAction` unset (advisory by default per the 2026-07-04 owner ruling).
- **Touched files:**
  - `src/lib/strategy-risk.ts`
  - `src/lib/strategy.ts`
  - `src/lib/socratic-runtime.ts`
  - `src/lib/defaults.ts`
  - `test/broker-minimum-sizing.test.ts`
  - `test/conviction-size-cap.test.ts`
  - `test/socratic-runtime.test.ts`
  - `test/thesis-size-multiplier.test.ts`
  - `test/vol-targeting-sizing.test.ts`
  - `STATUS.md`
  - `docs/rollouts/2026-11-22-wave1-sizing-risk-fixes.md`

## 3. Decisions & Trade-offs

- **Separating active risk-reduction multipliers (`advisedScale`) from the fallback exploratory-floor percentage:** Because `floor = 0.10` (`10% of max`) in `boundedMultiplier` is a percentage of `fallbackBase` for size-less proposals, multiplying an explicit `advisedNotional` by `0.10` would double-apply the exploratory percentage to already-small advised sizes.  Computing `advisedScale = Math.min(1, thesisScale * volScale * convictionScale * kellyScale)` ensures every active risk reduction (per-thesis multiplier, vol-targeting taper, conviction/degraded-data/drift/calibration haircuts, fractional-Kelly cuts, and `0x` hard stops) governs `advisedNotional` without altering baseline un-haircutted advised sizes.
- **Ordering `applySocraticOverrideSizing` before `applyDeterministicSizing`:** Running `applySocraticOverrideSizing` first allows an override thesis to propose a cash-deployment notional up to `socraticOverrideMaxPctOfNav`, while ensuring `applyDeterministicSizing` still enforces hard per-order caps, equal-risk budgets, ADV caps, and portfolio-heat tapers and banks the post-cap risk into `runningBookHeat`.
- **Single-audit post-bracket heat re-assertion:** `applyHeatCap()` records the fresh post-bracket audit payload into `heatAuditPayload` and emits `audit("sizing_heat_budget_applied", ...)` once after the post-bracket re-assertion so orders trimmed both before and after `bracketWholeShareMinimum` never produce duplicate audit rows or stale metrics.

## 4. Verification State

- `npm run lint` — passed (0 errors).
- `npx tsc --noEmit` — passed (0 type errors).
- `npx vitest run test/socratic-runtime.test.ts test/vol-targeting-sizing.test.ts test/thesis-size-multiplier.test.ts test/guard-enablement.test.ts test/strategy-moneypath-drawdown-flip.test.ts test/conviction-size-cap.test.ts test/final-size-red-autonomous.test.ts` — passed.
- `npm run build` — passed.

## 5. Next Steps & Blockers

- Push Kody review follow-up commit to `ag/wave1-sizing-risk`, resolve all 5 Kody threads on PR #5434, and merge once `verify` CI is green.
- No blockers.

## 6. Zero-Code Findings

- None (code and test changes landed in this rollout).
