# marketCap enrichment coverage + data catalog observability

## Context & Objective

Board item `2c62f3fde01447a7` (GROK): `marketCap` drives three of eight score factors but had no row in enrichment coverage reporting or the static data catalog.  Add observability entries following existing field patterns (smallest diff).

## Changes Made

- `COVERAGE_TRACKED_FIELDS` now includes `marketCap` so cascade coverage reports, ops snapshot enrichment summary, and completeness fallbacks can surface fill/missing state for the field.
- `CATALOG_FIELDS` gains a quote-category `marketCap` entry (`llmKey: mktCap`, NASDAQ screener preferred source) for admin catalog / completeness UI.
- Tests assert catalog + tracked inventory include `marketCap`.

**Files touched:**

- `src/lib/enrichment-coverage.ts`
- `src/lib/data-catalog.ts`
- `test/data-catalog-completeness.test.ts`
- `test/enrichment-coverage.test.ts`
- `docs/rollouts/2026-10-05-marketcap-coverage-catalog.md`
- `STATUS.md`
- `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Did **not** extend `EnrichmentSourcedField` / `takeScalar` / `applyEnrichment` in this pass — cascade merge records still omit `marketCap` unless a provider stamps it.  Coverage will show blanks until a follow-up wires screener/Yahoo cap into the enrichment map with provenance.  Catalog documents the intended sources today.
- Did not add `marketCap` to `COVERAGE_GAP_FIELDS` / `WAVE_B_GAP_FIELDS` (not requested; would change paid-provider gating).

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test test/enrichment-coverage.test.ts test/data-catalog-completeness.test.ts
```

## Next Steps & Blockers

- Optional follow-up: stamp `marketCap` + `sources.marketCap` from NASDAQ screener (and Yahoo when present) into cascade merge / `symbol_field_latest` so live fill rates reflect production.

## Zero-Code Findings

None.
