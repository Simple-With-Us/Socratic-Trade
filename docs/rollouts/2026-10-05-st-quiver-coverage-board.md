# ST: exclude retired Quiver lanes from enrichment coverage board (d550b5ee)

## Context & Objective

QuiverQuant direct access is retired and the provider is never registered, but five `*Quiver` carrier fields stayed in `COVERAGE_TRACKED_FIELDS`, pinning ~12% of the enrichment coverage board at zero and training operators to ignore the page.  Board item `d550b5ee` (P1).

## Changes Made

- Moved the five Quiver carrier fields into `COVERAGE_RETIRED_LANE_FIELDS` and removed them from active coverage tracking.
- Removed the dead `freeCashFlowYield` score ablation neutralizer (`scoreFactors` reads `fcfYield` only).
- Regression tests for retired-lane exclusion and ablation classification.

Files:

- `src/lib/enrichment-coverage.ts`
- `src/lib/source-value.ts`
- `test/enrichment-coverage.test.ts`
- `test/source-value.test.ts`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `docs/rollouts/2026-10-05-st-quiver-coverage-board.md`

## Decisions & Trade-offs

- Retired Quiver fields are not shown on the admin enrichment-coverage table (least UI churn); they are documented via `COVERAGE_RETIRED_LANE_FIELDS` only.
- `freeCashFlowYield` remains in `COVERAGE_TRACKED_FIELDS` and `COVERAGE_GAP_FIELDS` because Yahoo and other live providers still fill it; only the misleading ablation neutralizer was removed.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test -- test/enrichment-coverage.test.ts test/source-value.test.ts
npm run build
```

## Next Steps & Blockers

- None for merge; Kody review on PR.

## Zero-Code Findings

N/A — code change.
