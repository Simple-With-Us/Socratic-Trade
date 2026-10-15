# ST-3854: Quiver retired lanes — durable report sanitize + admin footnote

## Context & Objective

ST-3854 / PR #4217 already moved the five Quiver carrier fields into `COVERAGE_RETIRED_LANE_FIELDS` and removed them from `COVERAGE_TRACKED_FIELDS`.  Production can still serve pre-merge `enrichment_coverage_runs.report_json` rows that list those fields at 0%, which keeps the admin board noisy after redeploy.  This follow-up sanitizes on read and documents retired lanes in the API/UI.

## Changes Made

- `sanitizeEnrichmentCoverageReport()` strips retired-lane rows from `fields`, `missingFields`, and `partialFields`.
- `resolveEnrichmentCoverageReport()` always returns a sanitized report.
- New builds stamp `retiredLaneFields` on `EnrichmentCoverageReport`.
- Admin enrichment-coverage page shows a one-line retired-lane footnote (not scored).
- Playwright visual regression for the footnote (`test/e2e/visual.spec.ts`) + Auth.js session helper for e2e admin routes (`test/e2e/playwright-session.ts`, `playwright.config.ts` `AUTH_SECRET`).
- Regression tests for sanitize and `retiredLaneFields` on build.

Files:

- `src/lib/enrichment-coverage.ts`
- `src/lib/db-enrichment-coverage.ts`
- `app/admin/enrichment-coverage/enrichment-coverage-client.tsx`
- `test/e2e/visual.spec.ts`
- `test/e2e/playwright-session.ts`
- `test/e2e/dashboard-smoke.spec.ts`
- `test/e2e/console-a11y.spec.ts`
- `playwright.config.ts`
- `test/e2e/visual.spec.ts-snapshots/enrichment-coverage-retired-lanes-footnote-chromium-linux.png`
- `test/enrichment-coverage.test.ts`
- `docs/rollouts/2026-10-15-st-3854-quiver-coverage-sanitize.md`
- `STATUS.md`

## Decisions & Trade-offs

- Exclusion over N/A rows in the table (matches #4217 rollout); footnote only for discoverability.
- Sanitize on resolve, not on persist — avoids rewriting historical SQLite rows.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npx vitest run test/enrichment-coverage.test.ts test/enrichment-coverage-persistence.test.ts test/source-value.test.ts
npm test
npm run build
```

## Next Steps & Blockers

- Deployer merges PR; Linear ST-3854 can move to Done after verify on prod admin page.

## Zero-Code Findings

Core ST-3854 code landed in #4217 (`a8e23a64`); this PR closes the durable-report gap only.
