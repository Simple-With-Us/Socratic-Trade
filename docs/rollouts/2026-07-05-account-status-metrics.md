# 2026-07-05: Push account status metrics to Usage Monitor

## Summary
Added telemetry to track tech account caps and credits by pushing broker balances and limits to the API Usage Monitor.

## Why
This implements the feature request to track tech account balances and limits using the existing API Usage Monitor telemetry patterns.

## Files Touched
- `src/lib/usage-monitor-push.ts`: Extended `UsageMetricType` union to include `"balance"` and `"limit"`. Added `pushBrokerBalance` to format and emit the telemetry events using `enqueue`.
- `src/lib/alpaca.ts`: Wired `pushBrokerBalance` into `getPortfolio` to record Alpaca's cash, buying power, and equity.
- `src/lib/robinhood.ts`: Wired `pushBrokerBalance` into `getPortfolio` to record Robinhood's cash, buying power, and equity.

## Verification
Ran the standard quartet of verification commands successfully:
- `npm run lint`: Clean
- `npx tsc --noEmit`: Clean
- `npm run build`: Succeeded
- `npm test`: 2650 tests passed across 268 files

## Follow-ups
None currently.
