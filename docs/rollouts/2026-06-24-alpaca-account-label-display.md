# 2026-06-24 - Alpaca account label display

## Summary

- Accounts list rows for Alpaca and Alpaca MCP now show the saved user label as
  the row title.
- Paper/Brokerage remains visible in the subtitle as broker environment metadata.

## Why

- A newly added live Alpaca Roth IRA labeled "Roth IRA" was displayed as
  "Brokerage" because the list formatter used the inferred execution environment
  as the title instead of the persisted account label.

## Files

- `app/dashboard-client.tsx`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-24-alpaca-account-label-display.md`

## Verification

- `npm ci` - installed this worktree's missing dependencies; no tracked lockfile
  changes.
- `npx tsc --noEmit` - clean.
- `npm test` - 123 files / 1067 tests passed.
- `npm run build` - passed. Next.js rewrote generated TypeScript config files
  during build; generated drift was restored before commit.
- `git diff --check` - clean.

## Follow-ups

- None.
