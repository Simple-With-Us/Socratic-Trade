# 2026-06-18 — Cross-sectional + macro derived metrics

## Summary
Extended the in-house metric layer beyond per-company ratios into two new realms,
all computed from data we already pull (no new APIs), and fed them to the agent:

1. **Per-company cross-sectional** — `sectorRelStrength`: a name's intraday % move
   minus the average move of its sector among the scan candidates (relative
   strength). Computed once at scan finalization, so it rides on every candidate.
2. **Market internals** (across the scan) — advancers/decliners, breadth,
   % above 52-week midpoint, median P/E, median earnings yield, and a sector
   rotation map (avg move per sector, leaders first).
3. **Macro / economy** — derived from the existing FRED series: yield-curve spread
   (10Y − Fed funds), real 10Y, real Fed funds, misery index, and equity risk
   premium (market earnings yield − 10Y). Plus a correctness fix to the CPI feed.

## Why
The agent could see single-name fundamentals but had no read on (a) whether a move
is name-specific or sector-wide, (b) what the broad tape/valuation is doing, or
(c) the macro backdrop beyond raw rate levels. These are all standard, decision-
relevant and fully derivable from data already in hand.

## Bug fixed (macro)
`fetchFredSeries("CPIAUCSL")` used `limit=1`, returning the CPI **index level**
(~310) — rendered as `"310%"` whenever `FRED_API_KEY` was set (only `DEFAULT_MACRO`
hid it). Now requests `units=pc1` (year-over-year % change) so `cpiInflation` is a
true rate — without which `real10Y` / `realFedFunds` / `miseryIndex` would be
garbage. `fetchFredSeries` gained an optional `units` arg.

## Files
- `src/lib/macro-metrics.ts` — NEW. `MacroDerivedMetrics` + `deriveMacroMetrics(macro, {marketEarningsYield})`.
- `src/lib/market-internals.ts` — NEW. `MarketInternals` + `computeMarketInternals(scan)` (reuses `deriveMetrics` for earnings yield).
- `src/lib/macro.ts` — CPI `units=pc1` fix; `fetchFredSeries` optional `units` param.
- `src/lib/types.ts` — `MarketQuote.sectorRelStrength?`, `CandidateEvidence.sectorRelStrength?`.
- `src/lib/market.ts` — compute `sectorRelStrength` per candidate at scan finalization (needs ≥2 sector peers).
- `src/lib/strategy.ts` — compute `marketInternals` + `macroDerived` in `buildUserContent`; add both to the LLM `userContent` (replacing the narrower `marketBreadth`); add `secRelStr` per candidate in `compactMarketScanForPrompt`; document `secRelStr` / `macroDerived` / `marketInternals` in the system context.
- `src/lib/evidence.ts` — persist `sectorRelStrength` in the `signal_snapshot` digest.
- `app/dashboard-client.tsx` — "Sec RS" Market Scan column (defaultHidden, sortable).
- `app/ui/symbol-drilldown.tsx` — "Sector rel. strength" tile in the Derived Metrics card.
- `test/macro-metrics.test.ts`, `test/market-internals.test.ts` — NEW (8 tests).
- `test/evidence.test.ts` — +sectorRelStrength assertions.

## Verification
- `npx tsc --noEmit` → clean. `npm test` → **158 tests** pass (+8). `npm run build` → compiles, 11/11 pages.
- Live `GET /api/scan`: 28/30 candidates carry `sectorRelStrength` (2 omitted as the
  only member of their sector); INTC +1.36% vs its semiconductor peers; sector
  rotation Technology +3.12% (leader) → Pharmaceuticals −0.37% (laggard);
  advancers/decliners 26/4.
- Browser (1600×900): Symbol Drilldown shows "Sector rel. strength: +1.36%" for
  INTC; column gear exposes "Sec RS" alongside the other derived columns.
- Macro derived math unit-tested against `DEFAULT_MACRO`
  (curve −1.05pp, real10Y 1.10pp, realFedFunds 2.15pp, misery 7.00, ERP w/ 6% MEY = 1.80pp).

## Follow-ups (open)
- No dedicated **macro / market-internals UI panel** yet — these reach the LLM and
  (for sector RS) the table/drilldown, but the macro derived block and rotation map
  are backend→LLM only. A compact "Macro & Internals" strip is the natural next UI.
- Tuner still doesn't read the persisted `derived` / `sectorRelStrength` evidence
  back as an explicit learning signal (captured, not yet learned from).
- Further derivable-but-deferred: 2Y treasury for a true 10Y−2Y curve (needs the
  DGS2 series added to the macro fetch); M2 YoY growth (FRED `pc1`); Graham
  number / margin-of-safety per name.
