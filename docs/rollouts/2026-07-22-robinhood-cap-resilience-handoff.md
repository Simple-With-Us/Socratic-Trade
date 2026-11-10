# Handoff: Robinhood cap resilience deployment

Date: 2026-07-22
Owner lane: CODEX
Worktree: `/Users/jay/.codex/worktrees/socratic-robinhood-cap-fix`
Branch: `codex/robinhood-cap-fix`

## Objective

Land and deploy the account-aware max-spend fix requested after the Robinhood mobile settings
save failure. The target behavior is:

- Unrelated cap/guardrail saves must not fail because a transient Robinhood `getAccounts()` read is
  unavailable.
- Account readiness changes and autonomy activation must still verify the selected broker account.
- Effective buy order caps must not exceed current buying power, NAV, or the configured cap.
- Daily opening capacity must not exceed NAV; per-order buys use current buying power.
- Blank dual-mode controls default to percentage mode; explicit legacy dollar settings remain valid.

## Current repository state

- `9c208190` — implementation commit: `fix: make Robinhood guardrail caps account-aware`.
- `e943e9b9` — merge commit containing the latest `origin/main` (`fb96dcde`) after the landing
  guard found overlap in `STATUS.md`, `docs/EFFORT-LOG.md`, `src/lib/strategy.ts`, and
  `test/console-live-data-derive.test.ts`.
- Working tree is clean after the merge; no push, PR, merge to `main`, or production deployment has
  occurred.

## Implementation map

- `app/api/policy/route.ts`: skips selected-account broker verification when account readiness is
  unchanged; preserves verification for readiness/autonomy changes.
- `app/console/components/policy-form.tsx`: percentage-first mode when both cap fields are blank.
- `app/console/guardrails/field-defs.ts`: explains live account-aware effective caps.
- `src/lib/policy-caps.ts`: shared effective per-order and daily-cap resolution.
- `src/lib/policy.ts`: policy evaluation uses the shared account-aware per-order cap.
- `src/lib/strategy.ts`: deterministic sizing and proposal prompt use the same effective cap.
- `test/policy-save-resilience.test.ts`: Robinhood transient-save and autonomy-verification tests.
- `test/policy-caps.test.ts`, `test/console-live-data-derive.test.ts`,
  `test/washsale-modes.test.ts`: cap contract regressions.

## Verification receipts

Before the `origin/main` merge:

- Focused cap/save/account tests: 11/11 passed.
- Focused policy suite: 95/95 passed.
- Focused execution/wash-sale/console/cap suite: 102/102 passed.
- `npx tsc --noEmit`: passed.
- `npm run lint`: passed with zero errors (existing warnings remain).
- `npm run build`: passed.

The first landing attempt used the required Node 24 runtime:

```text
PATH=/opt/homebrew/opt/node@24/bin:$PATH bash scripts/land.sh --pr-title "fix: make Robinhood guardrail caps account-aware"
```

TypeScript passed. The full Vitest run then produced broad native-module failures because this
worktree's existing dependencies were compiled under Node 26:

```text
better_sqlite3.node was compiled against NODE_MODULE_VERSION 147
this Node 24 runtime requires NODE_MODULE_VERSION 137
```

Representative failures included `test/synthetic-stops.test.ts` (70/75),
`test/data-providers.test.ts` (58/110), `test/broker-protective-stops.test.ts` (66/70), and
`test/tradier.test.ts` (58/59). The run was stopped after the environmental failure; these are not
evidence of a regression in the Robinhood cap changes.

## Exact next steps

1. Stay in this worktree and use Node 24 for every command:

   ```bash
   cd /Users/jay/.codex/worktrees/socratic-robinhood-cap-fix
   export PATH=/opt/homebrew/opt/node@24/bin:$PATH
   node -p 'process.versions.node + " modules=" + process.versions.modules'
   ```

2. Rebuild the native dependency under Node 24. Prefer the narrow rebuild first; if another native
   module reports the same mismatch, reinstall dependencies under Node 24 without changing the lock:

   ```bash
   npm rebuild better-sqlite3
   # fallback only if needed:
   npm install --no-audit --no-fund
   ```

3. Re-run the focused receipt and then the full landing flow:

   ```bash
   npx vitest run test/washsale-modes.test.ts test/final-size-red-autonomous.test.ts \
     test/console-live-data-derive.test.ts test/policy-caps.test.ts \
     test/policy-save-resilience.test.ts --maxWorkers=1
   bash scripts/land.sh --pr-title "fix: make Robinhood guardrail caps account-aware"
   ```

   `land.sh` fetches/merges `origin/main`, runs `tsc`, full `npm test`, and `npm run build`, then
   pushes the branch and opens a PR. If the stale-overlap guard fires again, inspect each listed file,
   merge `origin/main`, verify the cap changes remain, and rerun; do not bypass the guard blindly.

4. On the opened PR, inspect required checks and review threads. Resolve actionable threads, then arm
   squash auto-merge only after the hosted `verify` check is green:

   ```bash
   gh pr view codex/robinhood-cap-fix --json number,url,mergeStateStatus,statusCheckRollup,reviews
   gh pr merge <number> --squash --auto
   ```

5. After merge, Coolify auto-deploys `socratic-trade-prod`. Verify the merged SHA is the deployed
   SHA, then check production health/readiness and perform one real Robinhood cap-only settings save.
   Confirm that an unavailable account-list read no longer blocks that save, while an autonomy/account
   readiness change still returns the intentional verification error when the broker is unavailable.
   Do not claim completion from a green health endpoint alone; record the exact deployment SHA and
   live behavior in the rollout note.

## Safety / scope

No broker order, account setting, production database, secret, provider credential, or deployment was
mutated by this lane. The runtime cap is computed from live account context; the user's configured
dollar value is retained for transparent UI/audit display rather than silently rewritten.
