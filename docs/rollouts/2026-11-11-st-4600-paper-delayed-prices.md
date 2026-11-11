# 2026-11-11 — ST-4600 Alpaca paper prices share one 15-minute clock

## 2026-11-11 correction (Jay, 11:47pm CT)

Alpaca's market-data API, not the paper trading host, serves quotes.  `paper-api.alpaca.markets` is orders, positions, and account.  Quotes and bars are `https://data.alpaca.markets`.  `feed=delayed_sip` is the 15-minute delayed SIP tape (stream path `v2/delayed_sip`).  A latest quote already carries its print time in `t`.  A free key's default latest trade is IEX, and `feed=sip` without a subscription returns "subscription does not permit querying recent SIP data", so the paper path keeps requesting `delayed_sip`.

Jay's correction: prefer that Alpaca quote, and when Alpaca returns nothing a later source is allowed.  Do not stamp the fallback with wall clock minus 15 minutes.  The UI says "Prices are generally 15-min delayed." and does not claim a per-price as-of.  Live accounts and Tradier paper are unchanged.  Portfolio equity totals stay the broker figure.

## Context & Objective

Alpaca's paper market fills on `delayed_sip`.  The execution cascade already asked that feed for quotes, but scan enrichment, Yahoo, charts, position marks, and on-demand quotes could still show a different print.  This change makes the prices an Alpaca PAPER account shows and decides on share one ~15-minute as-of.

## Changes Made

- Added `src/lib/paper-delayed-price-policy.ts`, a pure chooser.  It prefers `delayed_sip` inside the 900s ± 120s window, aligns other in-window prints and an untimestamped Nasdaq delayed screener to that as-of, withholds a fresher print, and can rewind minute bars to the last bar inside the window.  `src/lib/paper-delayed-price-account.ts` resolves the operating account.  Live accounts and Tradier paper pass through.
- Scan enrichment (`applyEnrichment`) and the finished scan stamp (`stampScanPaperDelay`) use the policy, and `mergeQuoteData` cannot put a fresher overlay back on a stamped scan.  Autopilot still reads `currentPricesFromScan`, so it follows the stamped scan.
- The quote cascade aligns its returned map for an Alpaca paper account, including the `skipActiveBroker` path that used to keep Yahoo.  The dashboard remarks position market value from that delayed price, filters stored order-ticket and proposal fallbacks, and attaches `priceDelay`.  `/api/quote` and `/api/watchlist` do the same.  `/api/history` replaces today's daily close with the delayed print while the cash session is open, and drops today's bar when no delayed print is available.  Price-alert notification bodies name the label and the as-of.
- The console scan, positions, orders, watchlist, and symbol drilldown, plus the iOS scan subtitle and symbol sheet, show `15-min delayed` with the as-of.

Touched files:

- `src/lib/paper-delayed-price-policy.ts`
- `src/lib/paper-delayed-price-account.ts`
- `src/lib/market.ts`
- `src/lib/quotes-cascade.ts`
- `src/lib/dashboard.ts`
- `src/lib/alerts.ts`
- `src/lib/types.ts`
- `app/dashboard-types.ts`
- `app/api/quote/route.ts`
- `app/api/watchlist/route.ts`
- `app/api/history/route.ts`
- `app/console/lib/format.ts`
- `app/console/scan/scan-table.tsx`
- `app/console/scan/columns.tsx`
- `app/console/components/positions.tsx`
- `app/console/orders/page.tsx`
- `app/console/watchlist/page.tsx`
- `app/console/ui/symbol-drilldown.tsx`
- `app/console/ui/drilldown-data.ts`
- `ios/SocraticTrade/DeskModels.swift`
- `ios/SocraticTrade/ScanView.swift`
- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTrade/SymbolInfoSheet.swift`
- `test/paper-delayed-price-policy.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-4-market-data-scoring.md`

## Decisions & Trade-offs

- The policy stays free of the database so the console can import the label constant.  Account lookup lives in the server-only sibling module.
- A full timestamp hours outside the window keeps its real as-of.  Stamping it to the canonical instant would pretend an old print was the 15-minute tape.
- Yahoo is not treated as a known-delayed provider.  Its chart quote can be near-live, so a missing timestamp is withheld.
- Position market value is recomputed as delayed price times quantity when a delayed price exists.  If none exists, the broker's own position mark is left in place.  Portfolio equity totals stay the broker's account figure, so they can disagree with the sum of remarked rows.
- Today's daily bar has no intraday timestamp.  During the open cash session the close is replaced or the bar is dropped.  High and low of that bar are not clamped, because clamping would invent the day's range.
- Fill prices and user-typed limit or stop prices are actual order prices and are not delayed.

Left out on purpose:

- Option marks.  They come from OPRA, not the equity `delayed_sip` tape.
- Portfolio account-equity totals versus the sum of remarked position rows.
- Fill prices, and limit or stop prices the user typed.
- Macro, VIX, benchmark sparklines, and equity curves.
- `src/lib/market-realtime.ts`, the Congress.Trade peer path.  Retargeting its IEX feed to `delayed_sip` would change a different app's point-in-time capture.
- Daily-bar high and low on the in-progress session.
- Tradier paper, which already has its own venue-delayed tape, and `alpaca-mcp`.
- When `delayed_sip` and a qualifying screener print both exist, `delayed_sip` wins.  A screener-only price stamped to the canonical as-of can still differ by cents from a missing sip print.

## Verification State

- `npx tsc --noEmit` clean.
- `npm run lint` 0 errors (867 grandfathered warnings).
- `npx vitest run test/paper-delayed-price-policy.test.ts test/quotes-cascade.test.ts test/market.test.ts` passed, including the paper skipActiveBroker case that now withholds a fresher-than-15-minute print.
- `npm test` (full vitest): 10188 passed, 41 skipped, 21 failed.  The two copy-rule failures were the watchlist tooltip sentence gap and are fixed.  The other 19 failures are environment: live provider keys make `llmForModel` return `OpenAILLM` instead of `MockLLM`, notify credentials are present, and host metadata is not a local workstation.  They do not touch the delayed-price policy.
- `NODE_OPTIONS=--max-old-space-size=4096 npm run build` completed.  The default heap aborted during the production compile on this VM.


## Next Steps & Blockers

Review the PR.  Do not merge from this lane.  iOS compile stays on the hosted `ios-build` workflow.  No production migration and no deploy from this change.

## Zero-Code Findings

The execution cascade already requested `delayed_sip` for the connected Alpaca paper account (PR #5005).  The disagreement Jay sees is the display path: scan enrichment could replace the screener price, `/api/quote` preferred the newer as-of, the watchlist `skipActiveBroker` cascade could fill with Yahoo, position `marketValue` came from the positions API, and daily history used an IEX bar.
