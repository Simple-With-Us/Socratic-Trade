# 2026-07-09 - Infinite loading fix for SSE events aborting fetchDashboard

- **Summary**: Fixed an issue where the Socratic Trade console would get stuck indefinitely on the "SOCRATIC TRADE" loading screen due to frequent `market-data` Server-Sent Events (SSE) aborting the dashboard's API fetch before it could complete.
- **Why**: The SSE `market-data` events trigger a UI `refresh()` every time they arrive (debounced at 200ms). The `refresh()` function was unconditionally aborting any `inFlight` request (throwing an `AbortError`) before starting a new one. When the `market-data` events arrive faster than the round-trip latency of `fetchDashboard`, the API fetch is continuously aborted and never resolves, causing the `loading` state in the UI to stay true forever.
- **Files**:
  - `app/console/lib/useConsoleData.tsx`
- **Verification**:
  - Ran `npm run lint` (0 errors).
  - Ran `npx tsc --noEmit` (clean).
  - Ran `npm test` (all tests passed).
  - Ran `npm run build` (clean).
- **Follow-ups**:
  - None.
