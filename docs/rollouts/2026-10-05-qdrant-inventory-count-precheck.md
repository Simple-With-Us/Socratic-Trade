# Qdrant inventory count pre-check (managed-vector reconcile)

## Context & Objective

Hourly dry-run `reconcileManagedVectorRecords` scrolled up to 50k Qdrant payloads and then threw `Vector inventory scan limit exceeded`, so the scheduler logged ~84 hard failures in four days without ever completing.  Add a cheap `POST /points/count` guard before scroll so over-ceiling tenants skip with one warning instead of burning scroll I/O every hour.

## Changes Made

- `src/lib/vector-store/qdrant-write.ts`: `VectorInventoryOverCeilingError`, shared metadata filter builder, `qdrantCountPointsByFilter`, pre-check in `qdrantInventoryByMetadata` before pagination.
- `src/lib/vector-db.ts`: reconcile maps the error to `skipped: true` plus `inventoryOverCeiling: { count, maxScanned }`.
- `test/qdrant-write.test.ts`, `test/vector-db-qdrant-retrieval.test.ts`: hermetic coverage.

## Decisions & Trade-offs

- Count uses the same tenant/metadata Qdrant filter as scroll (not the optional `prefix`, which is applied client-side after scroll).  That is intentionally conservative: if the filter matches more than 50k points, scroll would hit the ceiling anyway.
- Mid-scroll ceiling throw remains as a safety net if count races downward.

## Verification State

```bash
npm test -- test/qdrant-write.test.ts test/vector-db-qdrant-retrieval.test.ts
npm run lint
npx tsc --noEmit
```

38 tests in the two files pass; lint 0 errors; tsc clean.

## Next Steps & Blockers

- Operator may raise `VECTOR_INVENTORY_MAX_SCANNED` / implement prefix-aware server-side filtering if a full reconcile pass is required above 50k managed points.

## Zero-Code Findings

N/A.
