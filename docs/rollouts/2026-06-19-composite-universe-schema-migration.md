# Composite Universe & System State Schema Migration (2026-06-19)

## Summary
The `TradingPolicy` schema was overhauled to support composite universes (e.g., S&P 500 PLUS custom stocks) and a unified `systemState` string enum, replacing the outdated binary toggles `universe` / `allowlist` / `enabled` / `killSwitch`. Additionally, the policy sizing logic was updated to use a NAV percentage (`maxOrderPctOfNav`).

## Why
- **Composite Universe**: Users want the flexibility to trade an index (like the S&P 500) while also adding custom symbols (like SpaceX or TSLA) simultaneously, rather than being forced to choose strictly one or the other.
- **System State**: Having separate boolean flags (`enabled`, `killSwitch`) creates undefined/inconsistent states and brittle conditional logic. Migrating to a single explicit state machine (`active`, `halted`, `liquidating`, `close_only`) makes intent clear and robust.
- **NAV-Based Sizing**: Fixed dollar values for `maxOrderNotional` don't scale automatically as portfolio NAV grows or shrinks. Using a percentage of total NAV is the standard quantitative practice.

## Files Touched
- `src/lib/types.ts`: Deprecated `universe`, `allowlist`, `enabled`, `killSwitch`. Added `systemState`, `includedIndices`, `additionalSymbols`, `blocklist`, `maxOrderPctOfNav`.
- `src/lib/defaults.ts`: Updated `DEFAULT_POLICY` to use the new schema, setting `maxOrderPctOfNav` to 5%.
- `src/lib/policy.ts`: Implemented `allowedSymbolsForPolicy` which uses a Set to merge indices and additional symbols, and subtract blocklist symbols. Also integrated `systemState` and `maxOrderPctOfNav` in the evaluation logic.
- `src/lib/strategy.ts`: Updated strategy runner to respect the new `systemState` and calculate effective max notional dynamically using `workingPortfolio.totalMarketValue`.
- `src/lib/scheduler.ts`: Updated the cron scheduler to only run evaluations if `systemState` is `"active"`.
- `src/lib/strategy-tuning.ts`: Simplified the compact policy structure so LLMs tune relevant fields, omitting deprecated ones.
- `app/api/policy/route.ts` & `app/api/strategy/enable/route.ts`: Updated server API routes and validation to expect the new schema.
- `app/dashboard-client.tsx` & `app/ui/dashboard/settings.tsx`: Migrated frontend settings panels to bind to `includedIndices` arrays and `systemState` actions.
- `test/policy.test.ts` & `test/persistence-notification.test.ts`: Re-aligned test fixtures and removed implicit overrides that broke due to the new default `maxOrderPctOfNav`.

## Verification
The following verification sequence was executed directly in the worktree:
1. `npx tsc --noEmit` (Resolved several initial TypeScript failures relating to lingering properties)
2. `npm test` (All 223 tests pass cleanly)
3. `npm run build` (Next.js build succeeded cleanly)

## Follow-ups
- Need to expand the UI functionality for `blocklist`, which is currently supported by the backend but lacks dedicated frontend form fields.
- Eventually add more indices (e.g. `nasdaq100`, `russell2000`) to the `IndexUniverse` type and the dropdown selections.
