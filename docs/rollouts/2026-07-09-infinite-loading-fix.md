# 2026-07-09 — Infinite loading fix for SSE events aborting fetchDashboard (AG)

## Summary
The console UI was getting stuck on the loading screen due to frequent `market-data` Server-Sent Events (SSE) repeatedly aborting the `fetchDashboard` requests before they could complete. We fixed this by introducing a `background` flag to the `refresh()` function and making background refreshes (both SSE and intervals) skip if there is already an in-flight request.

## Why
`useConsoleData` uses an `AbortController` to cancel in-flight requests whenever a new refresh is triggered. `market-data` events arrive rapidly over SSE. Each event triggers a debounced `queueRefresh()`. Because the debounce was shorter than the request latency, a new refresh was continuously triggered, aborting the previous one and preventing the initial loading state from ever resolving. The fix allows the initial foreground refresh to complete uninterrupted while still honoring background refreshes when idle.

## Files
- `app/console/lib/useConsoleData.tsx`

## Verification
- Lint: `npm run lint` (clean)
- Types: `npx tsc --noEmit` (clean)
- Tests: `npm test` (passed)
- Build: `npm run build` (clean)

## Follow-ups
None.
