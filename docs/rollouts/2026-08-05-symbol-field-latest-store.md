# 2026-08-05 — Durable shared symbol field store (per-field timestamps)

## Context & Objective

Owner: market scan table blank for PE/EPS/div/news/rating even after strategy runs;
stale reuse was supposed to work; data should be shared across users and must keep
the most recent value for every field with its own date/time stamp — including symbols
that left the universe or yesterday’s scan.

Root cause of “no stale data”:

1. Interactive `/api/scan` used `enrichmentMode: "skip"`.
2. Strategy `strategy_run` audits **omit** the full MarketScan (`audit-bounded-run.ts`,
   `omitted: true`) — no `quotesBySymbol` to seed from.
3. In-process enrichment cache dies on restart and is not the UI seed path.
4. Whole-object seed merge could wipe rich values with blank interactive audits.

## Changes Made

- **v68 `symbol_field_latest` table** (shared, no user_id):
  - `PRIMARY KEY (symbol, field)`
  - `value_json`, `source`, **`as_of`**, **`fetched_at`** — **per field**, never scan-level only
  - Upsert only when incoming `fetched_at >=` stored (never clobber newer with older)
  - Symbols that leave the universe keep their last rows forever until overwritten field-by-field
- **`src/lib/db-fundamentals.ts`**: CRUD + `recordsFromEnrichmentMap` +
  `marketQuoteSummariesFromFieldStore` (fieldObservations carry per-field stamps into seed)
- **Cascade write**: after every enrich merge, persist all filled fields to the store
  (still appends numeric PIT history to `historical_fundamentals`)
- **`scanMarket`**: always load durable store as baseline before live enrich or skip-mode;
  field-level seed merge; persist candidates after each scan
- **`/api/scan`**: field-level merge of audit seeds (no whole-object wipe); store still loaded inside `scanMarket`
- **`applyEnrichment`**: merges `fieldObservations` instead of replacing them
- Schema pin tests → 67; new `test/symbol-field-latest.test.ts`

### Files touched

- `src/lib/db.ts` (migration v68 + baseline CREATE)
- `src/lib/db-fundamentals.ts`
- `src/lib/data-providers.ts`
- `src/lib/market.ts`
- `app/api/scan/route.ts`
- `test/symbol-field-latest.test.ts`
- `test/persistence-hardening.test.ts`
- `docs/rollouts/2026-08-05-symbol-field-latest-store.md`
- `docs/EFFORT-LOG.md`, `STATUS.md`

## Decisions & Trade-offs

- **Shared store (no user_id)** for public market fields — matches data-pool intent; no
  account-private portfolio fields are written.
- **Does not re-enable multi-MB strategy_run audits** — store is the durable recovery path.
- **Interactive scan still skip-mode for network fundamentals** on this PR, but now shows
  last-known store values with honest per-field ages. Full live refresh under rate limits
  remains follow-up (owner OK with optimizing non-intraday fields).
- Complex values (headlines arrays, analyst labels) stored as JSON.

## Verification State

```bash
npx tsc --noEmit
npx vitest run test/symbol-field-latest.test.ts test/persistence-hardening.test.ts
# 25 passed
```

## Next Steps & Blockers

- Populate store on next full strategy / trading-day freshness enrich (empty until then).
- Optional: force one background full enrich after deploy to warm PE/EPS for current universe.
- Surface per-field age chips in Scan UI (data already on `fieldObservations`).
- Ensure ROIC/Yahoo actually fill on strategy path (separate verification; this PR is the
  durability layer so fills are never thrown away again).

## Follow-on (same PR) — multi-broker fan-in + default share + loud shortfalls

### Changes
- **`fetchFreshQuotesCascade` Level 1b:** after the active broker, try **every other
  connected broker for that user** for remaining symbols (market-data only; never
  venue-authoritative for non-active). One user-scoped cascade — not per-account silos.
- **`hasDataPoolConsent`:** unset users **pool by default** (version 0 / no acceptedAt);
  explicit decline still turns pooling off; first-run gate still uses version bump.
- **`MarketScan.dataCoverage`:** fill rates + plain-language `shortfallSummary` + top gaps;
  pushed into `warnings` and a red **Data coverage shortfall** banner on `/console/scan`.

### Verification
```bash
npx vitest run test/data-pool-consent.test.ts test/scan-data-coverage.test.ts \
  test/quotes-cascade.test.ts test/symbol-field-latest.test.ts
```
