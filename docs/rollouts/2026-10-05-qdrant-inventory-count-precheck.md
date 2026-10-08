# Qdrant inventory count pre-check (managed-vector reconcile)

## Context & Objective

Hourly dry-run `reconcileManagedVectorRecords` scrolled up to 50k Qdrant payloads and then threw `Vector inventory scan limit exceeded`, so the scheduler logged ~84 hard failures in four days without ever completing.  Add a cheap `POST /points/count` guard before scroll so over-ceiling tenants skip with one warning instead of burning scroll I/O every hour.

## Changes Made

- `src/lib/vector-store/qdrant-write.ts`: `VectorInventoryOverCeilingError`, shared metadata filter builder, `qdrantCountPointsByFilter`, pre-check in `qdrantInventoryByMetadata` before pagination.
- `src/lib/vector-db.ts`: reconcile maps the error to `skipped: true` plus `inventoryOverCeiling: { count, maxScanned }`.
- `test/qdrant-write.test.ts`, `test/vector-db-qdrant-retrieval.test.ts`: hermetic coverage.

## Decisions & Trade-offs

- Count uses the same tenant/metadata Qdrant filter as scroll (not the optional `prefix`, which is applied client-side after scroll).  That is intentionally conservative: if the filter matches more than 50k points, scroll would hit the ceiling anyway.
- Mid-scroll ceiling throws the same `VectorInventoryOverCeilingError` if the count races downward, so reconcile soft-skips either detection point.

## Verification State

```bash
npx vitest run test/qdrant-write.test.ts test/vector-db-qdrant-retrieval.test.ts
npx eslint src/lib/vector-db.ts src/lib/vector-store/qdrant-write.ts test/qdrant-write.test.ts test/vector-db-qdrant-retrieval.test.ts
npx tsc --noEmit
```

39 tests passed.  eslint on those TypeScript files: 0 errors (pre-existing warnings only).  `npx tsc --noEmit` exit 0.  `npm run build` was not run on this seat.

## Next Steps & Blockers

- Operator may raise `VECTOR_INVENTORY_MAX_SCANNED` / implement prefix-aware server-side filtering if a full reconcile pass is required above 50k managed points.

## Zero-Code Findings

N/A.
