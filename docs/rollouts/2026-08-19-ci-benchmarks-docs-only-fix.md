# CI docs-only fast path: exclude build-imported docs/benchmarks

## Context & Objective

Expert review cluster `merge-gate-blindspots` / `qa-test-strategy:qa-03`: the docs-only classify regex in CI treated all of `docs/**` as documentation, but `app/api/llm-usage/model-stats/route.ts` statically imports `docs/benchmarks/*.json` at Next build time.  A PR touching only those JSON files could auto-merge with `verify` skipped and break production on deploy.

## Changes Made

- After the existing docs-class grep, re-add any changed paths under `docs/benchmarks/` to `non_docs` so lint/tsc/test/build (and e2e smoke) still run.
- Comment at each site points at the runtime import so the carve-out is not accidentally removed.

Files touched:

- `.github/workflows/ci.yml`
- `.github/workflows/e2e.yml`
- `ci-pending/e2e.yml` (mirrored stale copy)
- `docs/rollouts/2026-08-19-ci-benchmarks-docs-only-fix.md`
- `STATUS.md`
- `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- **Surgical carve-out, not dropping `^docs/`:** Removing the blanket `docs/**` clause would force full verify on non-`.md` paths like `docs/branding/*.html` that are not build-imported.  Only `docs/benchmarks/` is excluded from the fast path.
- **`scripts/land.sh` unchanged:** It does not implement the docs-only regex (runs full tsc/test/build always).
- **No Swift / ios-build gate:** Owner declined required xcodebuild per narrowed scope.

## Verification State

Classification sanity (bash snippet mirroring workflow logic):

```bash
# docs/benchmarks/*.json only -> docs_only=false (full gate)
# docs/rollouts/*.md only -> docs_only=true (fast path)
# docs/branding/*.html only -> docs_only=true (unchanged)
```

Commands run: inline bash classify simulation (see session transcript).  No application code changed; full `npm run lint` / `npm test` / `npm run build` not required for workflow-only edit.

## Next Steps & Blockers

- None for this item.  Remaining `merge-gate-blindspots` items (Swift gate, land.sh lint, etc.) are out of scope per owner.

## Zero-Code Findings

- `land.sh` has no docs-only classify regex — only CI/e2e workflows needed the fix.
