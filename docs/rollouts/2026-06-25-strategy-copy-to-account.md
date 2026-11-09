# Rollout: Strategy library copy-to-account (PR 2 of 3)

## Summary
Adds the "copy a saved strategy to a chosen account" capability — PR 2 of the per-account
roadmap, building on PR 1's library-vs-live split (`strategy_profiles` = user-level copyable
library; `account_strategy_state` = each account's live state).

## Why
PR 1 made `activateStrategyProfile` copy a library strategy into the **active** account's live
state. PR 2 generalizes that to **any** chosen account, so a user can run different saved
strategies on different connected accounts without switching the active account.

## What changed
- **`src/lib/db-profiles.ts`** — new `applyProfileToAccount(profileId, connectedAccountId, userId)`:
  reads the saved profile (ownership-checked), validates the target account (ownership-checked via
  `getConnectedAccount`), and writes the target account's `account_strategy_state` row with the
  profile's policy/prompt/scoringWeights + `derived_from_profile_id` provenance. Copy, not link.
  **Safety:** the target account's current `systemState` is preserved — applying a strategy is a
  config change and must never arm autonomy on a halted account (nor disarm an active one), mirroring
  PR 1's per-account autonomy-opt-in guard. Does NOT change the library active flag or which account
  is active.
- **`app/api/profiles/[id]/copy/route.ts`** — new `POST` route; body `{ connectedAccountId }`.
- **`app/api/connected-accounts/route.ts`** — new `GET` returning the user's accounts (safe subset,
  no secrets) for the UI picker.
- **`app/dashboard-client.tsx`** — `copyProfileToAccount` handler + a "Copy this strategy to another
  account" control under the Saved-strategy selector in the Strategy tab (only shown when the user
  has a non-active account to target).

## Files
- `src/lib/db-profiles.ts`
- `app/api/profiles/[id]/copy/route.ts` (new)
- `app/api/connected-accounts/route.ts`
- `app/dashboard-client.tsx`
- `test/strategy-copy-to-account.test.ts` (new)
- `docs/design/per-account-isolation.md`, `STATUS.md` (docs)

## Verification
- `npx tsc --noEmit` — clean.
- `npm test` — 1084/1085 (sole failure = pre-existing `cache-provenance` macro-cache env flake,
  unrelated — fails only where live network is reachable).
- `npm run build` — green.
- New tests: copy to a non-active account (active account untouched + provenance recorded),
  run-state preserved (copying an "active" strategy onto a halted account keeps it halted),
  unknown profile/account rejected.

## Follow-ups
- PR 3 of 3: sell-to-fund-buy as a 3-way setting (Automated / Propose / Suggest-only).
- Small pre-existing items from the safety-fixes note: Alpaca `o.type as OrderType` cast hiding raw
  `"stop"`; `getEquityOrders` `status:"all"` without pagination.
