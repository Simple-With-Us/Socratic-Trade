# 2026-06-28 — Proposal Dashboard UI Fixes

## Summary

- Fixed fresh proposal performance readouts so they do not show an immediate noisy gain/loss from delayed quotes or below-market limit anchors.
- Improved approval error handling for broker placement failures.
- Polished Market Scan column order/reordering, stale-refresh copy, Symbol drilldowns, Macro header alignment, and Performance unrealized P&L.
- Moved the scan fallback timestamp read out of render state after CI lint flagged the original implementation.

## Why

Live production rows showed V and KO proposals created at `2026-06-28T08:06Z` with `referencePrice` equal to the proposed limit/entry price, not the decision-time market quote. That made a fresh below-market limit order look like it had already moved `+0.6%` to `+0.8%` "since" proposal. BAC did not show the chip because its stored proposal lacked a reference price. The same production rows were older pre-fix proposals that still carried the small stale-cap sizing and Alpaca bracket error from the prior rollout.

`Run once` is deliberately manual/proposal-only even when the mode selector is Autonomous Mode; the UI now says that near pending approvals. The approve client also treated `{status:"error"}` as a generic success-ish result instead of a broker-placement failure, so the queue could look stale after an attempted approval.

Symbol drilldowns were using a generic fixed title and a separate scroll-body identity row; they now put symbol identity in the fixed slide-over header. The shared `SymbolButton` also preserved too little metadata when the symbol came from `quotesBySymbol`, causing some names to show sparse info or `$0.00` despite available scan data. `/api/history` now keeps close-only rows so imported/cache history can still render as a line chart.

The Performance tab's top-line Unrealized value was based on app-recorded open lots, while the Portfolio rail used current broker/display positions. For broker-held positions that predate app fills, the rail could show P&L while Performance showed `$0.00`.

## Files

- `app/api/history/route.ts`
- `app/api/scan/route.ts`
- `app/dashboard-client.tsx`
- `app/ui/macro-panel.tsx`
- `app/ui/overlays.tsx`
- `app/ui/price-chart.tsx`
- `app/ui/symbol-button.tsx`
- `app/ui/symbol-drilldown.tsx`
- `src/lib/dashboard.ts`
- `src/lib/strategy.ts`
- `test/history-route.test.ts`
- `test/strategy-hardening.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-3-performance.md`
- `docs/phase-7-strategy.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-06-28-proposal-dashboard-ui-fixes.md`

## Verification

- `npx tsc --noEmit` — passed.
- `npx vitest run test/strategy-hardening.test.ts test/history-route.test.ts test/proposal-performance.test.ts` — passed, 42 tests.
- `npm test` — passed, 155 files / 1,494 tests.
- `npm run build` — passed, existing Next middleware-to-proxy deprecation warning only.
- `npm run lint -- --quiet` — passed after the scan timestamp follow-up.
- Playwright against `http://localhost:4124/`:
  - dashboard loaded with no page errors;
  - Macro tab showed the title and aligned helper copy;
  - Performance tab showed the Unrealized tile;
  - Market Scan column chooser showed `Reset`, `Sector` before `Sec RS`, and reorder controls;
  - BAC symbol drilldown opened with fixed header identity and no `Symbol Intelligence` title.

## Follow-ups

- Local BAC `/api/history` returned no bars without keyed history providers. The close-only route path is now covered by test, but production history availability still depends on keyed/provider/cache data returning rows.
- Existing production V/KO proposal rows were generated before this branch and will retain their old stored reference/limit values; new proposals use the corrected anchor path.
