# 2026-06-25 — App B return-path: securities-import receiver + fundamentals/analyst push + numeric price targets

Branch: `claude/app-b-analytics-return-path-a50as4`

## Summary

Built the inbound half of the App A return-path plus the price-target provider that
fills the analyst push's previously-null target columns. **Reconciliation note:** the
`fundamentals[]`/`analyst[]` push (PR2 from the reply) had ALREADY landed on `main`
(via `marketQuoteToFundamentals`/`marketQuoteToAnalyst`, gated
`CONGRESS_SHARE_FUNDAMENTALS_ENABLED`, sourced from the scan's `MarketQuote`). This
branch did NOT duplicate it — an earlier draft did, and was dropped in favor of main's
design during the merge. All changes here are **additive and default-OFF**.

1. **`feat/securities-import-receiver` — inbound `POST /api/admin/securities/import`
   + local EOD cache tier (net-new; main has no receiver).** App A independently
   fetches price/spx/ref data and can now POST those gap-fills back to App B
   (symmetric with the body App B already POSTs to App A). Lands in a new local,
   writable EOD cache; an opt-in, density-guarded `fetchDailyOHLC` tier can serve it
   so an imported series displaces a re-fetch. Unblocks App A's previously-404 path.

2. **Numeric analyst price targets (FMP price-target-consensus; net-new).** New
   opt-in FMP call threads `targetMean/High/Low/Median` through the full enrichment
   surface onto the quote, and `marketQuoteToAnalyst` (main's builder) now emits them
   — so the existing `analyst[]` push fills those columns instead of sending `null`.

## Why

The reply doc committed App B to a receiver + a fundamentals/analyst push and
explicitly deferred numeric price targets "until we wire a price-target provider."
The fundamentals/analyst push already shipped on main; this branch adds the missing
receiver and wires the price-target provider so the analytics return-path is complete
rather than shipping permanently-null columns. Scoped to this one on-theme branch
(analytics return-path); off-theme backlog items from the discovery sweep are listed
under Follow-ups, not built here.

## Files

**PR1 — receiver + EOD cache tier**
- `src/lib/db.ts` — three new tables in `migrate()`: `imported_securities_ref`,
  `imported_price_eod` (PK `ticker,date`), `imported_spx_eod` (PK `date`); each
  carries an `origin` column (default `app-a`) for the no-echo guard. Barrel
  re-export of `./db-securities-import`.
- `src/lib/db-securities-import.ts` (new) — idempotent upserts
  (`upsertImportedRefs/Prices/Spx`, `persistSecuritiesImport`), reads for the
  cache tier (`getImportedPriceCloses`, `getImportedSpxCloses`), `getImportedRef`,
  `getImportedCacheCounts`, `clearImportedSecuritiesForTests`. Local row types (no
  import from `congress-share`) to keep the db barrel cycle-free.
- `src/lib/securities-import-auth.ts` (new) — constant-time bearer verify against
  `APP_B_INGEST_TOKEN`; default-closed.
- `app/api/admin/securities/import/route.ts` (new) — POST receiver; tolerant
  coercion; no-echo guard (skips a payload tagged with App B's own origin);
  insider/shortVolume accepted-and-ignored on the inbound path; returns counts.
- `src/lib/history.ts` — opt-in, density-guarded `fetchImportedHistory` wired as
  the first `fetchDailyOHLC` source (`SECURITIES_IMPORT_HISTORY_TIER_ENABLED`,
  `SECURITIES_IMPORT_MIN_BARS` default 200).
- `src/lib/congress-share.ts` — `APP_B_ORIGIN` constant + `origin?` on
  `CongressSharePayload`; outbound POST now stamps `origin` (no-echo-loop tag).

**congress-share.ts (origin tagging + targets on main's builder)**
- `src/lib/congress-share.ts` — `APP_B_ORIGIN` constant + `origin?` on
  `CongressSharePayload`; outbound POST stamps `origin` (no-echo-loop tag);
  `CongressAnalyst` gains optional `targetMean/High/Low/Median` and
  `marketQuoteToAnalyst` (main's builder) now emits them from the quote.

**Price targets (the net-new provider)**
- `src/lib/data-providers.ts` — `fmpPriceTargetsEnabled()` + opt-in 5th
  `Promise.allSettled` call to `price-target-consensus` in `FmpEnrichmentProvider`;
  `targetMean/High/Low/Median` added to `SymbolEnrichment`, `EnrichmentSourcedField`,
  the `takeScalar` calls, and `EMPTY_SOURCED`.
- `src/lib/types.ts` — 4 fields on `MarketQuote` + `MarketQuoteSummary`; 4 keys on
  the `EnrichmentSources` union.
- `src/lib/market.ts` — 4 fields folded into `applyEnrichment` + `quotesBySymbol`
  (the documented cross-file enrichment trap — all sites updated).

**Tests / config / docs**
- `test/securities-import.test.ts` (new, 17 cases), `test/congress-share-price-targets.test.ts`
  (new, 5 cases — targets flow into `marketQuoteToAnalyst`), `test/congress-share.test.ts`
  (merged with main; the body assertion already expects the new `origin` tag).
- `.env.example` — `APP_B_INGEST_TOKEN`, `SECURITIES_IMPORT_HISTORY_TIER_ENABLED`,
  `SECURITIES_IMPORT_MIN_BARS`, `CONGRESS_SHARE_FUNDAMENTALS`,
  `CONGRESS_SHARE_FUNDAMENTALS_MAX`, `FMP_PRICE_TARGETS_ENABLED`.
- `STATUS.md`, `PLAN.md`, `docs/congress-trade-share.md`,
  `docs/congress-trade-app-b-reply.md` updated to reflect built state.

## Verification

```
npx tsc --noEmit   # clean
npx vitest run     # 1088/1089 pass; only the pre-existing date-sensitive
                   # cache-provenance flake fails (documented in CLAUDE.md/STATUS.md)
npm run build      # compiles; /api/admin/securities/import registered
```

Focused: `npx vitest run test/securities-import.test.ts test/congress-share-fundamentals.test.ts test/congress-share.test.ts` → 56/56.

## Follow-ups (discovered, NOT built — off-theme for this branch / need authorization)

A discovery sweep enumerated the broader unbuilt backlog. Deliberately deferred —
each wants its own branch/PR (this branch is scoped to the analytics return-path),
and several touch the money/learning paths or need an owner decision:

- **Additive/low-risk (good next branches):** feed policy-blocked proposals into
  the counterfactual pipeline; OOS walk-forward no-op caution; read-only chat tools
  (`get_portfolio_pnl`/`get_performance_summary`/`get_reflection`); persist MAE/MFE
  per closed lot; surface `avgDaysHeld`/`shortTermPct`; prompt-cache the strategy
  system prefix; ATR-based stops opt-in mode; SEC XBRL company-facts connector.
- **Owner-decision / spend-gated:** raise Voyage paid-tier batch + 8-K ingest caps;
  full SEC filing-body RAG ingestion; voyage-3-large reindex; raise FMP scan cap.
- **Money-path (needs explicit sign-off):** replace `window.prompt` live-order
  approval with an in-app modal; per-account state isolation; shared saved-strategy
  library; sell-to-fund-buy; RH take-profit/partial-fill; native Alpaca trailing.

## Operator / cross-app actions

- Generate a scoped ingest token, set `APP_B_INGEST_TOKEN` on App B; hand App A the
  token + `APP_B_IMPORT_URL=https://socratictrade.com/api/admin/securities/import`
  out-of-band. Enable serving with `SECURITIES_IMPORT_HISTORY_TIER_ENABLED=on`.
- To send fundamentals/analyst: set `CONGRESS_SHARE_FUNDAMENTALS=on` (after App A's
  PR #46 migration is applied). For numeric targets: `FMP_PRICE_TARGETS_ENABLED=on`
  (confirm the FMP key tier supports `price-target-consensus`; it degrades to null
  gracefully on 403).
