# 2026-06-26 — Fix: Robinhood auth UX (no-token early exit + readiness chip)

## Summary

Three UX improvements for the Robinhood "not connected" state:

1. **Early exit when no token** — `callRobinhoodMcpMethod` now throws before making any HTTP
   request if no OAuth token is stored for the user. This prevents the silent empty-auth request
   that previously fell through to the API and returned HTTP 401.

2. **Friendlier error messages** — 401 responses now throw "Robinhood session expired — reconnect
   your account in Settings → Connections" instead of the raw "Robinhood MCP HTTP 401:
   authentication required". No-token throws "Robinhood not connected — reconnect your account in
   Settings → Connections".

3. **Readiness strip chip** — When `activeBroker === "robinhood"` and no OAuth token is stored
   (surfaced as `robinhoodMcpConnected: boolean` in the dashboard snapshot), a "⚠ Robinhood"
   chip appears in the readiness strip, linking to Connections. This makes the not-connected state
   visible at a glance rather than only discoverable via a failed order.

4. **UI translation of stored errors** — `humanizeBrokerError()` translates the already-stored
   "Robinhood MCP HTTP 401" strings in `trade_proposals.error_message` to the friendlier message
   in the Decisions tab, so old proposals look clean immediately after deploy.

## Why

Screenshots showed "Robinhood MCP HTTP 401: authentication required" as a red banner in the
Decisions tab for the Robinhood Brokerage view. The readiness strip already showed ⚠ Brokerage
(via `agenticAllowed`), but the error also surfaced redundantly as a noisy banner. The root cause
was that the agentic loop attempted broker calls without checking token presence first — making a
request with no auth header that guaranteed a 401.

Complements the PR #179 fix (broker fallback for `activeBroker: undefined`) — this fix covers
the case where Robinhood IS explicitly selected but the token is missing or expired.

## Files

- `src/lib/robinhood.ts` — early exit when `getMcpAccessToken` returns `undefined`; 401 branch
  now clears tokens and throws a friendly message rather than falling through to generic HTTP error.
- `src/lib/dashboard.ts` — import `getStoredMcpOAuthTokens`; add `robinhoodMcpConnected` field
  to snapshot (true when broker ≠ robinhood or when token is present).
- `app/dashboard-types.ts` — add `robinhoodMcpConnected: boolean` to `DashboardSnapshot`.
- `app/dashboard-client.tsx` — add `humanizeBrokerError()` helper; apply it to `item.errorMessage`
  in the Decisions error banner; add conditional "Robinhood" readiness item when not connected.
- `test/robinhood-mcp.test.ts` — update two tests that previously relied on token-less HTTP calls
  to explicitly store a token for `"user-a"` via `setMcpOAuthTokens`.
- `STATUS.md` — add the current-state entry for this Robinhood auth UX fix.
- `docs/rollouts/2026-06-26-robinhood-auth-ux.md` — this rollout note.

## Verification

```
npx tsc --noEmit   # clean
npm test           # 1257/1257 passed
npm run build      # clean
```

## Follow-ups

- Old proposals already in the DB with `error_message: "Robinhood MCP HTTP 401..."` are now
  displayed with the friendlier message in the UI (via `humanizeBrokerError`) — no DB migration
  needed.
- The readiness chip shows on page load (from the snapshot), so users see "⚠ Robinhood" before
  any order attempt rather than discovering it after a failed placement.
