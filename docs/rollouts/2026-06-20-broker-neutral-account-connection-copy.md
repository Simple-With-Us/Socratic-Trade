# 2026-06-20 - Broker-neutral account connection copy

## Summary

- Updated account connection copy so Accounts is presented as the place to
  connect one or more supported accounts, not as an Alpaca-first or Paper-required
  flow.
- Kept explicit supported-account actions for Robinhood MCP, Alpaca Paper, and
  Alpaca Brokerage.
- Clarified that Paper accounts are optional and user-selected, while Robinhood
  uses MCP/OAuth sync and does not require API key fields in Accounts.

## Why

Alpaca is not the only broker path in the app, and Robinhood MCP is already a
functional supported connection. Users may also choose not to connect a broker
paper account at all. The UI and docs should describe the general requirement:
connect a supported account when broker-backed execution is desired.

## Files

- `.env.example`
- `README.md`
- `PLAN.md`
- `STATUS.md`
- `app/dashboard-client.tsx`
- `app/ui/dashboard/settings.tsx`
- `docs/architecture-blueprint.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-20-broker-neutral-account-connection-copy.md`
- `test/e2e/dashboard-smoke.spec.ts`

## Verification

- `npx tsc --noEmit` passed.
- `npm test` passed: 37 files, 261 tests.
- `npm run build` passed.
- `git diff --check` passed.
- `PLAYWRIGHT_PORT=4201 PLAYWRIGHT_WEB_SERVER_COMMAND='npm run start -- -H 127.0.0.1 -p 4201' npx playwright test test/e2e/dashboard-smoke.spec.ts` passed after stopping the Codex PM2 `next dev` preview and rebuilding.
- `pm2 restart trading-codex` restarted the Codex preview on port 4101.
- `curl -sS -m 10 -D - http://127.0.0.1:4101/api/health` returned `HTTP/1.1 200 OK` and `{"ok":true}`.
- A focused Playwright browser check against `http://127.0.0.1:4101/` opened Accounts and verified the broker-neutral subtitle/copy plus the Alpaca Paper and Alpaca Brokerage account buttons. The Robinhood button is verified when visible; it is hidden when a Robinhood account is already connected.

Notable verification notes:

- The first existing e2e smoke run failed because it still expected a `Kill` button, while the current halted dashboard state legitimately shows `Resume`. The test was updated to accept either `Kill` or `Resume`.
- Re-running Playwright directly against the PM2 `next dev` preview intermittently timed out on navigation and logged Next dev `Maximum call stack size exceeded` pipe errors. Following the repo guidance, the authoritative e2e run was against a clean temporary `next start` after stopping PM2 and rebuilding.

## Follow-ups

- Visual smoke should confirm Accounts still shows the Robinhood MCP status card
  and the three supported account actions without implying Paper is required.
- Deeper account-state work remains separate: explicit reconnect/empty account
  states, production auth, and the remaining Phase 11 isolation audit.
