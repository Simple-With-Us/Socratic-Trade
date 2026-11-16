# 2026-08-05 — Provenance stamps completeness (source + asOf/fetchedAt)

## Context & Objective

Owner: every data point in scans and caches should record **timestamp + source
provenance**. The durable `symbol_field_latest` store (PR #2503) already requires
`source` / `as_of` / `fetched_at` per field; this pass closes gaps where values
were accepted without stamps (cascade drop of `sharesOutstanding`, headlines
without source, quote/bar merges, OHLC history cache, macro field map, calendar
provider receipts).

Companion catalog: `docs/source-capability-matrix.md` +
`src/lib/source-capability-matrix.ts` (preference ranks; not a single global
score).

## Changes Made

### Cascade enrichment (`data-providers.ts`)
- **`takeScalar("sharesOutstanding")`** — was in `EMPTY_SOURCED` but never
  takeScalar'd; providers returned it and merge dropped it with no store stamp.
- **`takeScalar("headlines")`** + `EnrichmentSourcedField` / `EMPTY_SOURCED` /
  `EnrichmentSources` include `headlines` so store never writes `source=unknown`.
- takeScalar always resolves **asOf** (provider fieldDates / asOf → cascade clock).

### Scan merge (`market.ts`)
- `mergeQuoteData` stamps `fieldObservations` for price/bid/ask/volume/asOf when
  broker/Yahoo quote data is accepted (sources already refreshed).
- `mergeGroupedBarData` stamps `fieldObservations.vwap` + sources.

### History bars + cache
- `OHLCBar.source` / `OHLCBar.fetchedAt` optional provenance.
- `stampOhlcBarProvenance` + cascade path stamps every tier id (massive, roic,
  yahoo-finance, …).
- **Migration v71** `history_cache_eod.source` (as_of = bar date, fetched_at =
  `updated_at`).

### Macro
- `MacroData.fieldSources` + `fetchedAt` on FRED and keyless fallback paths.

### Calendar
- Nasdaq calendar provider attaches `fieldObservations.daysToEarnings` with
  earnings date as asOf and provider source.

### Helpers / store
- `stampFieldObservation` in `evidence-facts.ts`.
- `symbol_field_latest` write path unchanged contract (still requires
  source/as_of/fetched_at); cascade + scan persist paths now feed complete stamps.

### Files touched
- `src/lib/evidence-facts.ts`
- `src/lib/types.ts`
- `src/lib/data-providers.ts`
- `src/lib/market.ts`
- `src/lib/history.ts`, `history-cache.ts`, `indicators.ts`
- `src/lib/macro.ts`
- `src/lib/nasdaq-calendar-provider.ts`
- `src/lib/db.ts` (v71 + baseline `history_cache_eod.source`; v70 plan_tier
  table-exists guard for legacy upgrade tests)
- `test/provenance-stamps.test.ts` (new)
- `test/persistence-hardening.test.ts` (schema pin → 71)

## Decisions & Trade-offs

- Headlines become a sourced field (first-wins array) for store/UI provenance;
  not score-arbitrated differently than before.
- No Scan UI redesign — consumers already read `fieldObservations` / sources;
  chips remain a follow-on.
- FMP not re-enabled. Avoided `db-api-keys` tier UI (peer agent on same branch).
- Migration **70** = `user_api_keys.plan_tier` (peer overhaul lane); **71** =
  history cache source. Both needed for schema pin 71.

## Gap audit (closed vs remaining)

| Area | Status |
|------|--------|
| Cascade scalars via takeScalar + fieldObservations | **Closed** (incl. sharesOutstanding, headlines, always asOf) |
| symbol_field_latest source/as_of/fetched_at | **Closed** (store + recordsFromEnrichmentMap; cascade/scan writers) |
| mergeQuoteData / mergeGroupedBarData observations | **Closed** |
| OHLC bars + history_cache_eod source | **Closed** |
| Macro per-field source map | **Closed** (fieldSources; not full FieldObservation shape) |
| Nasdaq calendar daysToEarnings stamps | **Closed** |
| Web-sources technical / congress / SEC | **Mostly already stamped** (technical has source/fetchedAt; SEC/RAG own pipeline) |
| Market-signals bundle (Cboe/CFTC/FF) | **Partial** — dataset-level asOf exists; no per-metric fieldSources yet |
| Economic calendar rows (non-earnings) | **Remaining** — no SymbolEnrichment carrier (by design in calendar provider notes) |
| Dividend/IPO calendar | **Remaining** — not wired to enrichment |
| Scan UI per-cell age chips | **Remaining** (data present; UI optional) |
| In-process enrichment cache entries | **Partial** — full SymbolEnrichment includes fieldObservations when cascade ran |

## Verification State

```bash
npx tsc --noEmit
npx vitest run test/provenance-stamps.test.ts test/symbol-field-latest.test.ts \
  test/market.test.ts test/persistence-hardening.test.ts
# 53+ tests green in focused set; tsc clean
```

## Next Steps & Blockers

- Peer settings-tier agent: Connections plan dropdown / STOPPED soft-health —
  coordinate on shared `db.ts` / `data-providers` when landing.
- Optional: market-signals per-field fieldSources; Scan table age chips.
- Warm `symbol_field_latest` via next strategy enrich after deploy.
