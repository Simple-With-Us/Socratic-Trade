# 2026-06-21 — Best-source precedence + source/time provenance tooltips

## Summary
1. **Real-time source now wins the price-family fields.** The enrichment cascade is first-wins
   by array order, and the real-time `AlpacaSnapshotEnrichmentProvider` (IEX snapshot) was seated
   *after* delayed providers (finnhub, webull), so a delayed `price`/`bid`/`ask`/`volume`/
   `intradayChangePct`/`vwap` could win over Alpaca's real-time value. Moved AlpacaSnapshot to the
   **front** of `getEnrichmentProvider` so the freshest market-data source wins. It only supplies
   market-data fields, so fundamentals sourcing (finnhub→fmp→yahoo) is untouched; it still
   self-skips when Alpaca keys are absent (delayed sources fill in exactly as before).
2. **Source + time on hover for every Market-Scan data point.** New shared `dataPointTitle(label,
   source, asOf)` helper (+ `derivedTitle` for `[CALCULATED]` columns). All 22 previously bare
   columns now show `Source: <provider> · Received HH:MM`, each attributed to that field's own
   `quote.sources[field]` (not a quote-level provider). Derived columns show "Computed from
   <inputs> · Received …" attributed to the *input* fields' real sources — never an invented
   provider. Fields with no provenance (`beta`, `shortPercentOfFloat`) show time only. Existing
   rich tooltips (price/sentiment/rating) are preserved.
3. **App-wide:** `StatTile` gained source/time support; account/portfolio tiles attribute to the
   broker source + time when known (Test-mode/local sim gets no fabricated source).
4. **Source-label polish:** `SOURCE_LABELS` now maps `alpaca-snapshot`/`alpaca-news`→"Alpaca" and
   `massive-vwap`→"Massive" so tooltips read polished names; the `vs VWAP` static header no longer
   hardcodes "Massive" (the per-cell tooltip shows the actual source).

## Why
- Owner asked the app to "use the most reliable and most current/up-to-date data source" and to
  show "the source and time" of any data point on hover (ideally app-wide).
- An understand-phase investigation found the cascade ordered by provider *availability*, not
  *freshness* — a concrete staler-source-wins risk for price/quote fields once real-time Alpaca
  was available — and that 22 of 30 scan columns exposed no source/time on hover.

## Files
- `src/lib/data-providers.ts` — `getEnrichmentProvider`: AlpacaSnapshot pushed first (freshness-tier
  comment); guards/fundamentals order unchanged.
- `src/lib/dashboard-ui.ts` — `SOURCE_LABELS` additions.
- `app/dashboard-client.tsx` — `dataPointTitle`/`derivedTitle` helpers; source+time `cellTitle` on
  all scan columns; `vsVwap` static title de-hardcoded.
- `app/ui/primitives.tsx` — `StatTile` source/time support.
- `test/data-providers.test.ts` — +2 tests: AlpacaSnapshot seated before finnhub, and its
  real-time `price/bid/ask/volume` win (incl. the contested volume) with `sources` stamped
  `alpaca-snapshot`.

## Verification
- `npx tsc --noEmit` — clean.
- `npm test` — **593 passed** (71 files).
- Adversarial verifier confirmed: reorder correct + never-fabricate preserved + per-field source
  attribution + no lost tooltip detail.

## Follow-ups (deferred — documented, not done)
- **COMPLETE freshness model:** a per-field-class `asOf` map (`priceAsOf`/`fundamentalsAsOf`/…)
  would let tooltips answer "price stale but P/E fresh?" and let the merge gate on real staleness
  (`preferFresher`) rather than first-wins. High cross-file cost (the per-field enrichment trap in
  CLAUDE.md); the single `asOf` with honest "Received" wording is shipped instead.
- `applyEnrichment`/`mergeQuoteData` still override unconditionally (first-wins); a `preferFresher`
  tiebreaker is the COMPLETE counterpart to the reorder above.
- Roll `dataPointTitle` to the remaining app-wide sites (Tax holdings, Proposal sizing, Performance).
