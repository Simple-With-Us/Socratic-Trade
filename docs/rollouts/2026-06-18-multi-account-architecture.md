# Rollout: Multi-Account Architecture

## Summary
Successfully overhauled the application architecture to support managing multiple live and paper accounts seamlessly from a single dashboard. Users can connect multiple Robinhood and Alpaca accounts and quickly toggle between them, fully isolating their execution and P&L tracking while dynamically reusing their configured `TradingPolicy` defaults.

## Why
Users wanted to trade across both paper and live environments simultaneously, or use Alpaca versus Robinhood easily without losing their preferred risk settings, and wanted the ability to test strategies side-by-side or migrate them.

## Implementation Details
1. **Schema & API Layer:**
   - Added `connected_accounts` table to SQLite schema with `upsertConnectedAccount`, `listConnectedAccounts`, `setActiveConnectedAccount`, `deleteConnectedAccount`, and `getActiveConnectedAccount`.
   - Built Next.js API Routes (`/api/connected-accounts`) using Next.js 15 async segments to support CRUD from the dashboard.
   - Refactored `getPolicy` in `src/lib/db.ts` to dynamically inherit `accountNumber`, `paperMode`, `activeBroker` and `connectedAccountId` from the `activeConnectedAccount`. This ingenious pivot prevented having to refactor the entire `runStrategyOnce` engine or the test suites since they automatically target the correct underlying account now.

2. **UI layer:**
   - Appended `connectedAccounts` to `DashboardSnapshot`.
   - Upgraded `SettingsModal` in `app/dashboard-client.tsx` with a new `Integrations` tab to display connected accounts. Built an edit modal to input Broker, Environment, Label, and API Keys.
   - Replaced the simple "Paper / Live" segmented control in the top Command Bar with a dropdown Account Switcher that activates the selected account seamlessly reloading the dashboard.

## Verification
- Unit Tests: Re-ran `npm test`. Encountered `NOT NULL constraint` on test mocks for `connected_accounts.label` and `Pinecone` mock missing from an earlier test file. Repaired tests and confirmed 139 passing tests.
- TypeScript: Verified Next.js 15 route compliance. `npx tsc --noEmit` exits cleanly with 0 errors.

## Follow-ups
- Storing `apiSecret` in plain-text SQLite is sufficient for local tools, but if hosted as a SaaS platform we must encrypt these values with `AES` or similar before writing to the database.
- Next, we should confirm the `AlpacaBrokerGateway` live API interactions correctly authenticate using these dynamic keys.
