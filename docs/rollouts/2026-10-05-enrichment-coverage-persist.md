# Enrichment coverage durable store

## Context & Objective

Board item `8fd801251acf4061`: enrichment coverage lived only in a process-global variable, so admin `/api/admin/enrichment-coverage` returned `available: false` after every redeploy until another cascade run.  Persist reports and expose run history for operators.

## Changes Made

- SQLite migration **94**: `enrichment_coverage_runs` (full report JSON per `as_of`) and `enrichment_coverage_fields` (per `as_of` + `field` rows for history).
- `src/lib/db-enrichment-coverage.ts`: persist, load latest, run history, field history, `resolveEnrichmentCoverageReport()`.
- `setLastEnrichmentCoverageReport` / `buildEnrichmentCoverageReport` now write through the setter and persist best-effort.
- Admin API, ops snapshot, data completeness, and `scripts/cascade-audit.ts` read via `resolveEnrichmentCoverageReport()`; API adds `history` (optional `historyLimit` query).
- `test/enrichment-coverage-persistence.test.ts`: persist + survive memory reset + multi-run history.

**Files:** `src/lib/db.ts`, `src/lib/db-enrichment-coverage.ts`, `src/lib/enrichment-coverage.ts`, `app/api/admin/enrichment-coverage/route.ts`, `src/lib/ops-snapshot.ts`, `src/lib/data-completeness.ts`, `scripts/cascade-audit.ts`, `test/enrichment-coverage-persistence.test.ts`, `docs/rollouts/2026-10-05-enrichment-coverage-persist.md`, `STATUS.md`, `docs/EFFORT-LOG.md`.

## Decisions & Trade-offs

- Global (not per-user/account) reports match existing in-memory semantics; multi-account attribution remains a separate audit item (admin-07).
- Prune to 120 runs on insert to cap table growth.
- Persistence is fire-and-forget from the setter so cascade/tests never fail on DB errors.

## Verification State

```bash
npm run lint          # 0 errors
npx tsc --noEmit      # clean
npx vitest run test/enrichment-coverage-persistence.test.ts test/enrichment-coverage.test.ts  # 17 passed
npm test              # (full gate at PR verify)
npm run build         # (full gate at PR verify)
```

## Next Steps & Blockers

- None for persistence.  Optional UI: surface `history` on Admin Enrichment Coverage page.

## Zero-Code Findings

- `setLastEnrichmentCoverageReport` had zero direct callers before this change; `buildEnrichmentCoverageReport` assigned the global directly.
