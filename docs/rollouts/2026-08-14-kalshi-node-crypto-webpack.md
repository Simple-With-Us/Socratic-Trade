# 2026-08-14 — Unstick PR #2707: rematch main + webpack `node:crypto`

## Context & Objective

PR #2707 (`grok/st-kalshi-exits-options`) was stuck on a verify-hosted
`npm run build` failure (CI run 31762430767) and a GitHub CONFLICTING
label after main moved.  Goal: rematch `origin/main` and fix the
client/edge compile so auto-merge can land the Kalshi / exits / options
ship.

## Changes Made

- Merged `origin/main` (merge-tree clean; GitHub CONFLICTING was phantom).
- `src/lib/kalshi.ts`: `import crypto from "node:crypto"` ->
  `import crypto from "crypto"`.  Next/webpack's scheme plugin handles
  `node:` BEFORE `resolve.alias`, so `"node:crypto": false` never
  applies and the client/edge compile dies with `UnhandledSchemeError`.
  Bare `crypto` goes through `resolve.fallback`.  Same established
  pattern as `src/lib/apns.ts` and `src/lib/learning-review.ts`.
- Header comment updated so it no longer says "only node:crypto".

Touched files:

- `src/lib/kalshi.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`
- `docs/rollouts/2026-08-14-kalshi-node-crypto-webpack.md`

## Decisions & Trade-offs

Did not change other `node:crypto` imports (`mobile-auth-handoff.ts`,
`rag/universe-manifest.ts`, tests, scripts).  Those were not on the
failing import trace.  Did not run the full test/build locally; CI
verify-hosted is the gate.

## Verification State

- `git merge origin/main --no-edit` — clean, exit 0.
- Optional: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit`
  if Node 24 is present.

## Next Steps & Blockers

Push after a 60s wait (phantom-conflict burst), then
`gh pr merge 2707 --squash --auto`.  Blocker is only required `verify`.

## Zero-Code Findings

GitHub mergeable_state CONFLICTING after main moved was phantom:
`git merge-tree` reported no conflicts.
