# SSE Deadlock Fix

## Summary
Fixed a deadlock issue in the Next.js `/console` dashboard where opening a new tab would cause the Next.js dev server or production server to hang indefinitely when loading the page.

## Why
When a user opened multiple tabs of the dashboard (or closed and reopened tabs without the EventSource terminating fast enough), the server's HTTP/1.1 connection pool limit (which restricts to 6 concurrent active connections per domain) would become exhausted by long-lived Server-Sent Events (SSE) connections. Because the dashboard opens a new `EventSource` on mount, a background tab would hold one of the 6 connections forever. When the limit was reached, any new fetch requests (such as the initial dashboard data fetch for a new tab) would hang in a "pending" state indefinitely, causing a deadlock where the dashboard only showed a blank screen. 

By tying the EventSource connection to the document's visibility state, we ensure that background tabs gracefully disconnect, freeing up the connection pool for active tabs.

## Files
- `app/console/lib/useConsoleData.tsx`

## Verification
- Wrote the code locally.
- Verified that `isVisible` state gracefully closes the stream on `visibilitychange` events to `"hidden"`, and remounts when `"visible"`.
- Ran `npm run lint` and `npx tsc --noEmit` and `npm run build` using the land script.

## Follow-ups
None.
