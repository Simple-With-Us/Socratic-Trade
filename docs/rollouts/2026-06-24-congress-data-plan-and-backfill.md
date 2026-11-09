# 2026-06-24 — Bidirectional data plan + deep-history backfill

Branch: `agent/claude-congress-backfill`.

## Summary
Owner asked to make the App B ↔ App A (congress.trade) sharing genuinely bidirectional with no gaps,
no costly redundancies, and a no-paid-access / low-cap future plan. Ran an exhaustive 2-app data-source
inventory (workflow), wrote the plan, and added the one missing code piece (deep-history backfill).

## Inventory headlines
- **App A's `price_eod` is FMP-only** (~230-call/day cap shared with enrichment; degrades to "--" with no
  fallback) — its single point of failure for prices. (FMP is cheap — Starter tier, ~tens of $/mo; the
  earlier "~$1.3k/mo" was an erroneous inventory-agent estimate, since corrected. The real risk is the
  daily cap + single-source fragility, not the dollar cost.)
- **App B's prices come from Massive/Tradier (paid) + Yahoo/Stooq (free)** → App B feeding App A prices
  offloads App A's most fragile dependency. **Stooq = free deep-history floor** for both.
- App A needs prices back to each *trade's* date (years); the #134 ~1y nightly cap would starve that.

## Plan (`docs/congress-trade-data-plan.md`)
Sharing matrix: App B = market-data provider (prices/spx/refs/fundamentals/analyst/insider/short-vol);
App A = congressional authority (trades + analytics). Each consumes the other; neither double-fetches.
- **Redundancies to kill:** drop App B's paid Apify House actor + scrapers (use App A as congress source);
  App A cuts FMP price-refresh + enrichment to gap-fills (App B feeds it).
- **Future floor:** Stooq+Yahoo (prices), SEC EDGAR+Yahoo (refs), free congress sources — fetch-once-
  share-twice so nothing needs a paid tier.
- **#1 gap flagged:** price **adjustment** — App A's FMP closes are split/dividend-adjusted; App B's are
  mostly raw (Yahoo `close`/Tradier/Stooq) + some adjusted (Massive). Must reconcile before App A trusts
  App B prices for performance; until then App B prices are fill/fallback, not overwrite.

## Code (deep-history backfill)
- `runCongressDailyShare({ fullHistory: true })` bypasses the per-symbol close cap (sends full series,
  still chunked into small bounded POSTs). Nightly run stays recent-capped.
- Admin route `POST /api/admin/congress-share` accepts `{ fullHistory?: boolean }` (with optional
  `symbols`). One-time/on-demand deep backfill.
- +1 test (full-series bypass). tsc clean; push suite 35 pass; full trio via land.sh.

## Files
`src/lib/congress-share.ts`, `app/api/admin/congress-share/route.ts`, `test/congress-share.test.ts`,
`docs/congress-trade-data-plan.md` (new), `docs/congress-trade-share.md`, this note.

## Follow-ups
- Resolve price-adjustment (§4.1 of the plan) — likely a follow-up to send adjusted closes (use
  Yahoo `adjClose` etc.) once App A confirms its expectation.
- After App A's #46 migration: flip `CONGRESS_SHARE_FUNDAMENTALS_ENABLED`.
- Run a one-time `{"fullHistory": true}` backfill in prod (ideally over App A's distinct ticker list).
