# 2026-11-12 — ST-4612: Simple-With-Us org slug sweep (OPS-734)

## Context & Objective

Fleet repos moved from the `jaywedgeworth22` personal GitHub account to the `Simple-With-Us` org.  This pass finishes live `Simple-With-Us` slugs in operational docs, config snapshots, and `package.json` metadata, and adds a regression test so new stale owner strings do not creep back in.

## Changes Made

- Updated live URLs and slugs in `PROJECT.md`, `docs/deployment.md`, `docs/atlas-integration-map.md`, `docs/atlas/**`, `scripts/ios-fleet/README.md`, and `protection.json`.
- Corrected present-tense `STATUS.md` repo references; left historical PR/Actions URLs unchanged.
- Added `repository` / `bugs` / `homepage` to `package.json` pointing at `Simple-With-Us/Socratic-Trade`.
- Added `test/github-org-slug.test.ts` guardrail.
- Clarified `shared-package-pin-check.yml` header (npm scope vs git source).

**Files:** see PR diff.

## Decisions & Trade-offs

- **Left unchanged:** `docs/rollouts/**`, `docs/EFFORT-LOG.md`, dated handoffs/audits/reviews, `reference/atlas-public*` provenance, `.github/CODEOWNERS` (`@jaywedgeworth22` user), GitHub noreply email in workflows/skills, `scripts/sync-effort-issues.py` default assignee, and all `@jaywedgeworth22/congress-trading-shared` import paths (published npm scope until shared package renames).
- **STATUS historical PR links** kept under old `github.com/jaywedgeworth22/.../pull/` URLs to avoid falsifying the ledger.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
# optional: actionlint .github/workflows/*.yml
```

## Next Steps & Blockers

- When `congress-trading-shared` publishes under `@simple-with-us/*`, follow up with a coordinated consumer rename (ST / UM / CT).

## Zero-Code Findings

- `main` was already largely migrated; most remaining matches were npm scope, CODEOWNERS, or archived notes.
