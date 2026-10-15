# 2026-10-15 — ESLint 10 verify unblock (board d428460a)

## Context & Objective

GB-Monitor board item `d428460a` flagged PR #4325 / Renovate `eslint` v10 with required `verify` red: `npm run lint` aborted loading `react/display-name` because `eslint-plugin-react` called `contextOrFilename.getFilename()`, which ESLint 10 removed.  This was a toolchain / lockfile skew issue, not a new lint finding.

## Changes Made

- Bumped `eslint` to `^10` and aligned `eslint-config-next` to `^16.4.0` in `package.json` / `package-lock.json` (lock resolution matches green Renovate PR #4691 on current `main`).
- Renovate: group `eslint` and `eslint-config-next` under `eslint-toolchain` so major eslint bumps refresh the Next eslint preset in the same PR.
- Updated `AGENTS.md`, `eslint.config.mjs` header, `STATUS.md`, and `PLAN.md`.

**Files**

- `package.json`
- `package-lock.json`
- `renovate.json`
- `eslint.config.mjs`
- `AGENTS.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-10-15-eslint-10-verify-unblock.md`

## Decisions & Trade-offs

- **Root cause:** PR #4325’s lockfile resolved `eslint@10.12.0` but left `eslint-config-next@16.3.8`; rebased Renovate PR #4691 on current `main` resolves `eslint-config-next@16.4.0` and `verify` passes with the same `eslint-plugin-react@7.37.5`.
- **Renovate grouping** trades a slightly wider dependency PR for avoiding another stale-preset failure mode.
- Supersedes open Renovate PR #4691 (same dependency delta); close #4691 after this lands.

## Verification State

Commands run on branch `cursor/block-eslint-10-renovate-5081` after merging `origin/main` (2026-10-15, through `2075c857`):

```bash
git merge origin/main -m "Merge origin/main into cursor/block-eslint-10-renovate-5081"
npm run lint
npx tsc --noEmit
npm test
npm run build
```

- `git merge origin/main` — clean auto-merge (resolved GitHub `mergeable_state: dirty` after `2075c857`).
- `npm run lint` — 0 errors (baseline warnings).
- `npx tsc --noEmit` — ok.
- `npm test` — 9375 passed, 25 failed (12 files; cloud env / no-keys; unrelated to eslint).
- `npm run build` — ok.

## Next Steps & Blockers

- GB-Deployer: squash-merge the ready PR; close duplicate #4691.
- Board comment with PR URL (CURSOR seat has no Zulip/Linear write credentials in this cloud VM).

## Zero-Code Findings

- Reproduced failure with commit `2bf5e06` lockfile (`eslint-config-next@16.3.8`); passing lock from `558a417` / current main + eslint 10.
