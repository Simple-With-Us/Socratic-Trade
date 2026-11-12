# Node 26 toolchain alignment (Renovate PR #4953)

## Context & Objective

Renovate PR #4953 bumped CI and production Docker to Node 26 but left `.nvmrc`, `@types/node`, landing scripts, devcontainer, and `test/toolchain-policy.test.ts` on Node 24.  Required `verify` / `verify-hosted` failed on the policy gate, not on native-module or runtime incompatibility.

## Changes Made

- Aligned advisory/runtime pins: `.nvmrc`, `@types/node` ^26, `scripts/land.sh`, `scripts/cursor-cloud-install.sh`, `.devcontainer/devcontainer.json`.
- Updated `test/toolchain-policy.test.ts` and Cursor cloud note in `AGENTS.md`; `PLAN.md` runtime paragraph.
- Renovate commit (already on branch): GitHub Actions `setup-node` 26, `Dockerfile` `node:26.12.0-bookworm-slim`.

**Files touched (this fix commit):**

- `.nvmrc`
- `package.json`, `package-lock.json`
- `test/toolchain-policy.test.ts`
- `scripts/land.sh`, `scripts/cursor-cloud-install.sh`
- `.devcontainer/devcontainer.json`
- `AGENTS.md`, `PLAN.md`, `STATUS.md`

## Decisions & Trade-offs

- No `engines` field added; the structural gate remains `test/toolchain-policy.test.ts` plus `land.sh`.
- Left historical rollout/review docs mentioning Node 24 unchanged (archive).

## Verification State

```bash
export PATH="$HOME/.nvm/versions/node/v26.13.0/bin:$PATH"
node -v   # v26.13.0
npm run lint          # 0 errors
npx tsc --noEmit      # clean
npx vitest run test/toolchain-policy.test.ts  # 5/5 pass
```

Full `npm test` on the cloud VM showed unrelated env-specific failures (e.g. `server-metrics` local-host detection); hosted CI is authoritative for the full suite.

## Next Steps & Blockers

- Await hosted `verify` + `verify-hosted` on PR head.
- Owner Mac lanes should `brew link node@26` (or PATH to `node@26`) before `scripts/land.sh`.

## Zero-Code Findings

Root cause of red CI: policy test expected Node 24 while workflows/Dockerfile already targeted 26.
