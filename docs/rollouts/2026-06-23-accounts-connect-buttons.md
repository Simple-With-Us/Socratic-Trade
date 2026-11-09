# 2026-06-23 - Accounts connect buttons

## Summary

Removed the separate top-level Robinhood MCP status card from the Accounts modal.
Robinhood now appears as a peer connect action alongside Alpaca and Alpaca MCP,
instead of rendering a disconnected account-like panel when the MCP endpoint is
configured but no token is stored.

## Why

The configured Robinhood MCP endpoint is transport setup, not a connected
account. Showing it as a large disconnected card above the account buttons made
Robinhood look special and blank compared with the other broker connection
choices.

## Files

- `app/dashboard-client.tsx` - removed the rendered Robinhood MCP status card
  and made the health probe silent.
- `docs/phase-11-multi-user.md` - updated Accounts behavior.
- `PLAN.md` - aligned the Phase 11 status row with the new Accounts behavior.
- `STATUS.md` - added current-state handoff note.
- `docs/rollouts/2026-06-23-accounts-connect-buttons.md` - this note.

## Verification

- Initial `npx tsc --noEmit` before installing dependencies failed because this
  task worktree had no `node_modules`, so `npx` invoked the placeholder `tsc`
  package instead of the repo-pinned TypeScript compiler.
- `npm ci` - installed the lockfile dependencies for this worktree.
- `npx tsc --noEmit` - clean.
- `npm test` - 97 files passed, 886 tests passed.
- `npm run build` - clean.
- Focused Playwright smoke against `next start` on `127.0.0.1:4213` with the
  local Cloudflare Access test header - opened Accounts, verified the
  Robinhood/Alpaca/Alpaca MCP connect buttons, and verified the old
  `Robinhood MCP` / `Not connected` panel is absent.

## Follow-ups

- If a future Robinhood diagnostics surface is needed, put it behind an explicit
  details action instead of restoring an always-visible disconnected card in the
  main Accounts flow.
