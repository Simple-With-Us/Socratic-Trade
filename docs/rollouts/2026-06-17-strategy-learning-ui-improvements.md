# 2026-06-17 - strategy-learning-ui-improvements

## Summary

Follow-on improvement pass (branch `web-sources`) after merging Codex's
"2026-06-17 optimizations". Three areas: strategy, LLM learning, and UI. Paper
mode unchanged. `tsc` clean, 121 tests, build ok; UI browser-verified.

### Strategy
- **Regime detection now uses rates, not just VIX.** `determineMarketRegime`
  (`macro.ts`) was VIX-only despite its name; it now factors the **yield-curve
  inversion** (10y below Fed funds) — a classic recession signal — nudging
  borderline VIX into risk-off and surfacing a distinct "Cautious (Inverted
  Curve)" regime in calm-but-inverted markets. Kept to a small repeatable label
  set so the thesis×regime learning buckets stay dense.
- **Edge-aware position sizing.** `applyDeterministicSizing` previously scaled by
  `winRate × conviction` only; it now also multiplies by an **edge factor** from
  the learned shrunk average return, so a thesis that wins often but with no/
  negative expectancy isn't over-sized, and a proven positive-edge thesis earns
  more. The shrunk stats prevent a few lucky trades from inflating size.
- **Configurable sizing bounds.** `policy.tuning.sizingFloorPct` /
  `sizingCeilingPct` (default 10/100) replace the hard-coded 10–100% clamp,
  exposed in Settings → Tuning and validated in the policy route.

### LLM / learning
- **Signal-efficacy feedback (learn from more).** New `getSignalEfficacy`
  (`performance.ts`) joins closed lots to the per-run `signal_snapshot` audit (via
  a new `entryRunId` on `ClosedLot`) and reports the realized win rate of buys that
  had a **congressional / insider tailwind at entry vs the baseline**. Fed to the
  agent as `signalEfficacy` so it learns which evidence actually predicts wins
  rather than trusting signals on faith. Prompt now also tells the agent its
  `confidenceScore` deterministically drives sizing, so it calibrates conviction
  honestly.

### UI
- **Smart Money panel** (Market tab): surfaces the full scraped congressional +
  insider datasets (the scan's Congress column only shows scan-overlap symbols),
  with per-source freshness. New `smartMoney` on the dashboard snapshot.
- Confirmed in-browser: the **live `/api/scan`** populates FCF%/D/E/EPS gr with
  real Yahoo data (META 1.7% / 0.36 / 62%), the header shows "Agentic Trading" +
  stacked "Autonomy On" / "Pre-market" status dots, and the Smart Money panel
  renders.

## Files

- `src/lib/macro.ts` (richer regime), `src/lib/strategy.ts` (edge-aware sizing,
  configurable bounds, signalEfficacy + conviction-calibration prompt),
  `src/lib/performance.ts` (`getSignalEfficacy`, `ClosedLot.entryRunId`),
  `src/lib/types.ts` (`TuningSettings.sizingFloorPct/sizingCeilingPct`),
  `app/api/policy/route.ts` (validation), `app/dashboard-client.tsx` (Tuning
  sizing inputs, `SmartMoneyView`), `src/lib/dashboard.ts` + `app/dashboard-types.ts`
  (`smartMoney`), `test/macro.test.ts`, `test/performance.test.ts`.

## Verification

```bash
npx tsc --noEmit   # clean
npm test           # 121 passed (16 files; +3: regime ×2, signal-efficacy)
npm run build      # succeeds
```

## Follow-ups

- Re-run the adversarial review workflow on the UI batch + this pass (the prior
  run hit the Anthropic session limit).
- Deeper signal-efficacy: bucket by sentiment/value tiers and by sell-signal
  efficacy; surface efficacy in the UI.
- Consider a deterministic "de-risk in Crisis regime" guardrail (currently regime
  is context only).
