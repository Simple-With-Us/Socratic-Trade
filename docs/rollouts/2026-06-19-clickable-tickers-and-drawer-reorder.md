# 2026-06-19: Clickable tickers everywhere + symbol drawer reorder

## Summary
Two UI changes to the cockpit, both shipped in commit `8d5de0f` (bundled into a
generic "advance phase 10/11" commit during an editor outage; this note is the
missing handoff paper trail for that work):

1. **Symbol drilldown drawer reorder.** In `SymbolDrilldown`, moved **Evidence
   Bulletins** above the factor/provenance section and pulled **Source
   Provenance** out of the old two-column grid so it now sits full-width at the
   very bottom. New top-to-bottom order: AI Conviction Summary → Derived Metrics
   → Evidence Bulletins → Factor Scores → Source Provenance.

2. **Clickable tickers across the whole app** (previously only Market Scan rows
   opened the drilldown). Every standalone ticker now opens the same Symbol
   Intelligence drawer: Decision (pending + latest proposals), Portfolio rail,
   Tax (harvest candidates, open lots, wash sales, and the red wash-sale lockout
   chips), and Smart Money (Congressional trades + Insider Form 4 activity).

## Why
- The drawer order buried the most useful catalyst content (Evidence Bulletins)
  under the factor table; provenance is reference material and reads better last.
- Tickers were only actionable in Market Scan. Users expect to click a symbol
  anywhere (a proposal, a holding, a congressional disclosure) and get the same
  intelligence drawer.

## Key implementation notes
- The drilldown needs a full `MarketQuote`. The persisted
  `latestStrategyRun.marketScan` is **not rehydrated after a server restart**, so
  resolving clicked symbols against it failed silently (tickers fell back to
  plain text). Fix: the dashboard now fetches a **live `/api/scan`** once on
  mount (`tickerScan` state) — the same source Market Scan uses — and resolves
  symbols against `tickerScan ?? latestStrategyRun.marketScan` via
  `resolveScanQuote` (prefers fully-scored `topCandidates`, falls back to the
  lighter `quotesBySymbol` summary, filling only the MarketQuote-required fields
  so the drawer shows real data or `—`, never fabricated numbers).
- New `SymbolButton` component (drop-in for the `<span>{symbol}</span>` pattern):
  - `variant="underline"` (default): always-on faint underline as the at-rest
    discoverability cue; thickens + turns link-blue (`--info`) on hover; brief
    press (`active:scale-95`). No box.
  - `variant="chip"`: for tickers inside an already-colored Chip (red wash-sale
    lockout). Keeps the chip's color/box; goes bold-italic + underline on hover
    so the red "locked" meaning is preserved.
  - Degrades to plain text when there's no `onDrilldown` or the symbol isn't in
    the scan.
- Threaded `scan={drilldownScan}` + `onDrilldown={setDrilldownSymbol}` into
  `DecisionView`, `PortfolioRail`, `TaxView`, and `SmartMoneyView`.

## Files Touched
- `app/ui/symbol-drilldown.tsx`: drawer reorder (Evidence Bulletins up, Source
  Provenance full-width at bottom; unwrapped the 2-col grid).
- `app/dashboard-client.tsx`: `tickerScan` live-scan fetch + `drilldownScan`;
  `resolveScanQuote`; `SymbolButton` (underline + chip variants); wired
  `scan`/`onDrilldown` into Decision, Portfolio rail, Tax (incl. lockout chips),
  and Smart Money; converted all standalone ticker render sites.

## Verification
- `npx tsc --noEmit` — clean.
- `npm test` — 210 passed (28 files).
- `npm run build` — clean (a transient ENOENT build failure was only the dev
  server racing on `.next`; a clean rebuild with the dev server stopped passed).
- Live-checked in the :3000 dev preview: counted clickable tickers per tab
  (Decision 35, Tax 101 underline + 16 lockout chips, Smart Money 17), confirmed
  a click opens the drawer, and verified the new drawer section order.

## Follow-ups
- Activity / Notifications feed renders symbols **inside formatted sentences**
  (not standalone elements), so those are intentionally left non-clickable;
  making them clickable means parsing message strings. Revisit if desired.
- The summary-fallback path (`quotesBySymbol` only) shows a neutral `+0.00%`
  day-change in the drawer header because the summary carries no
  `intradayChangePct`; acceptable but could be suppressed if it bothers anyone.
