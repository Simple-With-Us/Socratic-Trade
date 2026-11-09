# Account write guards — preserve Autopilot authority + block draining reactivation

## Context & Objective

Expert review Part II cluster `account-write-guards` (tranche 1): account-scoped copy paths could silently flip `strategyAuthority` (Autopilot vs Ask-first) or reactivate a disconnected account while the scheduler drains it.  Fix without adding new TypedConfirm ceremony — authority stays account-owned like `systemState`.

## Changes Made

- `copyPolicyConfigToActiveAccount`, `applyProfileToAccount`, and `importAccountSettings` now pin the target account's existing `strategyAuthority` alongside `systemState` when copying config.
- `setActiveConnectedAccount` throws when the row has `is_draining = 1`.
- `upsertConnectedAccount` clears `is_draining` on reconnect (re-upsert).

**Files touched:**

- `src/lib/db-profiles.ts`
- `src/lib/db-api-keys.ts`
- `test/copy-config-preserves-arming.test.ts`
- `test/strategy-copy-to-account.test.ts`
- `test/settings-import.test.ts`
- `test/set-active-connected-account-draining.test.ts`

## Decisions & Trade-offs

- No new blocking UI or TypedConfirm phrases — the only way to change Autopilot remains Guardrails typed confirm.
- Draining accounts are refused on activate; reconnect via `upsertConnectedAccount` clears the drain flag (explicit re-connect cancels wind-down).
- Did not expand into per-account visibility UI (`brokers.tsx` draining labels) — separate PR per review scope.

## Verification State

```bash
npm run lint          # 0 errors (771 grandfathered warnings)
npx tsc --noEmit      # pass
npm test -- test/copy-config-preserves-arming.test.ts test/strategy-copy-to-account.test.ts test/settings-import.test.ts test/set-active-connected-account-draining.test.ts  # 18/18 pass
npm run build         # pass
```

Full `npm test` in cloud VM reported 36 pre-existing failures in unrelated vector-db suites (exit masked by `tail`); targeted cluster tests and build are green.

## Next Steps & Blockers

- Merge PR; auto-deploy on `main`.
- Follow-up (out of scope): grey/disable Load/Use for draining rows in `brokers.tsx`, chrome ScopeSelector, iOS HomeView.

## Zero-Code Findings

None — code change only.
