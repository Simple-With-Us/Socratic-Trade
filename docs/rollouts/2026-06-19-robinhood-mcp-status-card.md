# 2026-06-19 - Robinhood MCP status card

## Summary

- Added a Robinhood MCP connection status card to the Accounts modal.
- The card calls `GET /api/broker/mcp/health` and displays adapter mode,
  endpoint/protocol, latest check time, available tool names, errors/warnings,
  and connected/not-connected state.
- Added Refresh and OAuth-connect actions directly in the Accounts surface.
- Marked remaining mutable API route handlers as dynamic after `next build`
  tried to collect static page data for OAuth/account/policy/order routes.
- Fixed the existing factor-scorecard type issue in `src/lib/performance.ts`
  so the current analytics worktree remains buildable.

## Why

- The MCP transport hardening made backend diagnostics available, but the app
  still hid that state behind a raw API route. Users need to see whether the app
  is in mock mode, missing a token, failing `tools/list`, or connected to the
  official Trading MCP before relying on Robinhood data.

## Files

- `app/dashboard-client.tsx`
- `app/api/auth/robinhood/callback/route.ts`
- `app/api/auth/robinhood/start/route.ts`
- `app/api/connected-accounts/route.ts`
- `app/api/connected-accounts/[id]/route.ts`
- `app/api/connected-accounts/[id]/activate/route.ts`
- `app/api/keys/route.ts`
- `app/api/market/flatfile/route.ts`
- `app/api/orders/cancel/route.ts`
- `app/api/policy/route.ts`
- `app/api/strategy/enable/route.ts`
- `app/api/strategy/pause/route.ts`
- `src/lib/performance.ts`
- `PLAN.md`
- `STATUS.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-19-robinhood-mcp-status-card.md`

## Verification

- `npx tsc --noEmit` - passed.
- `npm test` - passed, 201 tests across 28 files.
- `npm run build` - passed.

Note: the first typecheck found an unfinished `src/lib/performance.ts`
factor-scorecard issue (`dominantFactor`/optional symbol narrowing), which was
fixed here before rerunning the full sequence. Earlier build attempts also
surfaced static page-data collection failures for mutable API route handlers;
those routes are now explicitly dynamic.

## Follow-ups

- Test the status card against a real authenticated Robinhood Agentic account
  and record the actual tool list shown for the account.
- Add deterministic execution-gate/draft/reconciliation hardening before adding
  any new live-order automation.
