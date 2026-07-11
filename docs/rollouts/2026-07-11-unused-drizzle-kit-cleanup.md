# 2026-07-11 — Unused drizzle-kit audit-chain cleanup

## Summary

Removed the unused `drizzle-kit` development dependency while retaining the actively used
`drizzle-orm` runtime. The removal clears the repository's last four npm audit findings without a
runtime database, schema, or migration behavior change.

## Why

`drizzle-kit@0.31.10` was not invoked by any npm script, GitHub workflow, repository script,
configuration file, source module, or test. It was the sole path to this dev-only advisory chain:

`drizzle-kit -> @esbuild-kit/esm-loader -> @esbuild-kit/core-utils -> esbuild@0.18.20`

The `esbuild` node is affected by `GHSA-67mh-4wv8-2f99`. Before removal, `npm audit --json`
reported four moderate findings (`drizzle-kit`, both `@esbuild-kit` packages, and `esbuild`) while
`npm audit --omit=dev --json` was already clean. npm's suggested downgrade to
`drizzle-kit@0.18.1` would keep an unused CLI and was not appropriate.

The application still imports `drizzle-orm` in `src/lib/db-settings.ts`, `src/lib/db/client.ts`, and
`src/lib/db/schema.ts`; `drizzle-orm@0.45.2` remains in the manifest and lockfile.

## Files

- `package.json` — removed only `devDependencies.drizzle-kit`.
- `package-lock.json` — removed the root pin plus 54 package nodes exclusive to the unused CLI
  (`drizzle-kit`, `@drizzle-team/brocli`, the legacy `@esbuild-kit` loader/core subtree, and their
  nested esbuild platform packages). Every retained package object matches the prior lock.
- `STATUS.md` — recorded current state and remaining serialized verification.
- `PLAN.md` — recorded this as dependency hygiene with no roadmap/runtime scope change.
- `docs/EFFORT-LOG.md` — mirrored the active CODEX claim and verification state.
- `docs/rollouts/2026-07-11-unused-drizzle-kit-cleanup.md` — this note.

## Verification

All commands used Node `v24.18.0` and npm `11.16.0` unless noted.

- `rg -n --hidden -i 'drizzle([- _]?kit)?|drizzle-kit|drizzleConfig|drizzle:|drizzle generate|drizzle migrate|drizzle push' --glob '!package-lock.json' --glob '!docs/**' --glob '!node_modules/**' --glob '!.git/**' .`
  - found only the manifest declaration; no CLI consumer or config.
- `find . -path './.git' -prune -o -path './node_modules' -prune -o -type f \( -iname 'drizzle.config.*' -o -iname '*drizzle*' \) -print`
  - found no Drizzle Kit config; the only filename match was the historical rollout note.
- `npm audit --json` before removal
  - expected exit 1; four moderate, dev-only findings on the chain above.
- `npm audit --omit=dev --json` before removal
  - exit 0; zero production findings.
- `npm pkg delete devDependencies.drizzle-kit`
  - removed the single manifest entry under Node 24 npm.
- `npm uninstall --package-lock-only --ignore-scripts drizzle-kit`
  - proved npm's resolved post-removal graph but also proposed unrelated textual lock reordering;
    retained nodes were restored and the final lock was narrowed to the exclusive subtree.
- Node semantic comparison of `HEAD:package-lock.json` against the final lock
  - `exact-base-minus-drizzle-kit-chain`; 963 prior package entries versus 909 final entries.
- `npm ci --dry-run --ignore-scripts`
  - exit 0; package/lock integrity accepted.
- `npm audit --json`
  - exit 0; zero vulnerabilities.
- `npm audit --omit=dev --json`
  - exit 0; zero vulnerabilities.
- `npx tsc --noEmit`
  - exit 0.
- `npm run lint`
  - exit 0 with 0 errors / 404 inherited warnings.

Notable no-op: an initial `npm uninstall --save-dev drizzle-kit` reified dependencies in the fresh
worktree but did not modify the manifest, so the explicit `npm pkg delete` path was used instead.

## Follow-ups

- Run the serialized full Vitest and Next production-build gate after the coordinating session
  releases it.
- Commit, push, open a ready PR, merge, and production-verify only from the parent CODEX session.
