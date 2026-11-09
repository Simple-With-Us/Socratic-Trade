# 2026-06-25 — ATR-based stops (opt-in) + stop/exit reference doc + stale-doc fixes

Branch: `claude/atr-stops` (off `origin/main`). Adds a volatility-aware stop mode and
documents the full stop/exit surface. The new stop mode is **opt-in, default OFF** —
no behavior change until `policy.atrStops` is set.

## Summary

1. **ATR-based stops (new per-position stop mode).** When `policy.atrStops` is on, the
   protective stop DISTANCE becomes `atrStopMultiple × ATR(atrStopPeriod)` as a % of
   entry (clamped 1%–50%), instead of the fixed `riskRules.stopLossPct` — a stop driven
   by the name's own realized daily range, adapting per-symbol without needing a beta.
   - Pure primitives `trueRange`, `atr`, `atrStopPct` added to `src/lib/indicators.ts`.
   - Policy fields: `atrStops?: boolean` (sibling of `betaScaledStops`) +
     `riskRules.atrStopPeriod` (default 14, 5–100) + `riskRules.atrStopMultiple`
     (default 2.0, 0–10), validated in the policy route.
   - Wiring mirrors the existing `betaBySymbol` precompute: the async strategy loop
     computes an ATR stop-% per open position from `fetchDailyOHLC` bars and passes a
     map into the (still-pure, sync) `generateProactiveRiskProposals`. Applies only when
     `stopLossPct > 0` and **falls back to the fixed/beta stop when bars are
     unavailable** — a position is never left unprotected. ATR takes precedence over
     beta-scaling when both are on.

2. **Reference doc** `docs/stop-loss-and-exit-strategies.md` — canonical, skimmable
   inventory of every stop / exit / circuit-breaker / pre-trade gate / compliance exit
   (per-position, order-level, account-level, pre-trade, tax), how they compose, and
   guidance on choosing fixed vs beta-scaled vs ATR stops.

3. **Stale-doc fix** (PLAN.md): the Phase-7 "Remaining" list still listed persisted
   MAE/MFE per closed lot, tuner consumption of missed opportunities, and true
   candidate-vs-baseline OOS validation — all of which are LIVE. Corrected.

## Files

- `src/lib/indicators.ts` — `trueRange`, `atr`, `atrStopPct` (pure).
- `src/lib/types.ts` — `RiskRules.atrStopPeriod`/`atrStopMultiple`; `TradingPolicy.atrStops`.
- `src/lib/strategy.ts` — async ATR precompute at the proactive call site + optional
  `atrStopPctBySymbol` param consumed by `generateProactiveRiskProposals` (precedence +
  fallback). New imports: `atr`/`atrStopPct` (indicators), `fetchDailyOHLC` (history).
- `app/api/policy/route.ts` — bounds validation for the three new fields.
- `test/atr-indicators.test.ts` (new) — `trueRange`/`atr`/`atrStopPct` incl. close-only
  bars, clamps, invalid inputs. `test/strategy-hardening.test.ts` (+5) — ATR distance
  wider/tighter, precedence over beta, fallback when absent, ignored when off.
- `docs/stop-loss-and-exit-strategies.md` (new), `PLAN.md` (stale-line fix), `STATUS.md`.

## Verification

```
npx tsc --noEmit   # clean
npx vitest run     # 1125/1126 (+12); only the pre-existing cache-provenance date flake
npm run build      # compiles green
```

## Notes / follow-ups

- ATR currently drives the deterministic **proactive risk-exit** distance (the central
  per-cycle stop decision). The synthetic-trailing and Alpaca-bracket/RH-broker stop
  PLACEMENT paths still use the fixed/beta percent; extending ATR into those placement
  paths is a natural follow-up (they each derive their own stop percent).
- The SEC XBRL company-facts enrichment connector is the remaining backlog item, built
  separately on `claude/sec-xbrl-enrichment`.
