# 2026-07-06 Account Running State

## Summary
Updated the account switcher UI to display the running state (e.g., "Running · Autopilot", "Exit-only", "Stopped") of each connected account alongside its name, fulfilling the user's request to see which accounts are running at a glance.

## Why
Previously, the account switcher only indicated if an account was active and whether it was a live or paper account. The actual running state was only visible for the currently active account in the header. Bringing this into the switcher allows the user to quickly assess the trading status of all connected accounts without switching scopes.

## Files Touched
- `app/dashboard-types.ts`: Augmented `DashboardSnapshot` with a `connectedAccountPolicies` mapping.
- `src/lib/dashboard.ts`: Populated the `connectedAccountPolicies` field using `getPolicy()` for each connected account during snapshot generation.
- `app/console/lib/derive.ts`: Relaxed the type of `deriveStateInfo()` from full `TradingPolicy` to `Pick<TradingPolicy, "systemState" | "strategyAuthority">`.
- `app/console/components/chrome.tsx`: Utilized `connectedAccountPolicies` and `deriveStateInfo()` to render a `Chip` with the running state next to each account in the switcher list.

## Verification
- `npx tsc --noEmit` passed on the modified files (existing unrelated TS errors in `congress-stream.ts` are documented elsewhere).
- Checked the component structure logic to ensure halted states are correctly hidden/filtered as required.
