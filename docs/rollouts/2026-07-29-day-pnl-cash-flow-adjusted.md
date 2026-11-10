1. **Context & Objective**: The dashboard's Day P&L calculation (`deriveDayPnl`) was doing a simple `currentEquity - baseline.equity` difference. This caused massive swings when the user deposited or withdrew cash on the current day, because the cash flow was not netted out. The goal was to make Day P&L cash-flow-aware.
2. **Changes Made**:
   - Reused the `inferExternalCashFlows` function from `src/lib/benchmark.ts` to inspect the delta between the `baseline` snapshot and the live `portfolio`.
   - Updated `deriveDayPnl` (in `app/console/lib/derive.ts`) to receive the full `portfolio` object instead of just equity.
   - Updated the `page.tsx` dashboard to pass `portfolio`.
   - Updated `test/console-live-data-derive.test.ts` to supply mock portfolio objects.
3. **Decisions & Trade-offs**: 
   - `inferExternalCashFlows` requires an array of `EquityCurvePoint`. I created a mock `fakeCurrent` point from the live portfolio data to feed it to the function. This perfectly reuses the battle-tested logic.
4. **Verification State**:
   - `npx tsc --noEmit` and `npm run build` ran successfully.
   - `npm test` passed, verifying no regressions in the day PNL tests.
5. **Next Steps & Blockers**: 
   - Wait for the user to confirm the dashboard P&L is displaying correctly after the Coolify auto-deploy.
6. **Zero-Code Findings**: N/A
