# 2026-06-27 - Robinhood balance visibility + fallback audit trail

## Summary

Investigated why the Robinhood Agentic balance was not updating, then made the
account/auth state and broker fallback paths visible:

- Settings -> Accounts no longer treats a stored Robinhood account row as fully
  connected when Robinhood MCP is not authenticated. It now shows `OAuth Needed`
  plus a Reconnect action.
- Robinhood portfolio parsing now handles nested cash/buying-power payloads and
  cash-only accounts where total value/cash fields are omitted or renamed.
- Dashboard broker read fallbacks, selected-account backfills, Robinhood quote
  failures, and average-cost valuation fallbacks now emit throttled
  `recoverable_issue` audit events.
- Activity feed formatting now renders those audit rows as readable diagnostics.
- Vitest now caps workers at 4 and uses a 20s global timeout after full-suite
  verification hit unrelated cold-import/concurrency timeouts across older tests
  in this fresh worktree.

## Why

Production evidence showed this was not a confirmed $100 balance parser issue
alone. The live dashboard was active on the Alpaca Roth IRA account, not the
Robinhood Agentic account. The Robinhood MCP health endpoint was configured but
unauthenticated:

```bash
curl -H 'cf-access-authenticated-user-email: mail@jaywedgeworth.com' \
  http://127.0.0.1:4000/api/broker/mcp/health
```

Returned:

```json
{
  "ok": false,
  "configured": true,
  "authenticated": false,
  "error": "No Robinhood MCP access token is stored or configured. Connect OAuth or set ROBINHOOD_MCP_AUTH_TOKEN."
}
```

So the Robinhood row represented stored metadata, not a live authenticated
balance source. The app also had broker/data fallback paths that only wrote to
`console.warn`, which made later correction difficult. Those now record visible,
throttled Activity diagnostics.

## Files

- `app/dashboard-client.tsx`
- `src/lib/dashboard.ts`
- `src/lib/dashboard-feed.ts`
- `src/lib/recoverable-issue.ts`
- `src/lib/robinhood.ts`
- `test/dashboard-feed.test.ts`
- `test/recoverable-issue.test.ts`
- `test/robinhood-mcp.test.ts`
- `vitest.config.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-27-robinhood-balance-failover-audit.md`

## Verification

```bash
npm install
npm test -- --run test/robinhood-mcp.test.ts test/dashboard-feed.test.ts test/recoverable-issue.test.ts
npx tsc --noEmit
npm test
npm run build
npm run lint
```

Results:

- Focused tests: 3 files passed, 22 tests passed.
- TypeScript: passed.
- Initial full `npm test` runs failed on unrelated timeout/concurrency pressure
  across older suites; a warm rerun of the first failing files passed 38/38, and
  `test/persistence-notification.test.ts` passed 16/16 alone after a full-suite
  timeout. Vitest was capped at 4 workers with a 20s global timeout before final
  full-suite verification.
- Final full tests: 151 files passed, 1451 tests passed.
- Production build: passed.
- Lint: passed with 0 errors / 218 warnings (known warning backlog).

## Follow-ups

- Reconnect Robinhood OAuth before expecting the Agentic Robinhood balance to
  refresh.
- Consider extending `recordRecoverableIssue` to more provider fallback paths
  beyond the broker/account dashboard path touched here.
- If Robinhood still reports zero after OAuth reconnect, capture the raw
  `get_portfolio` MCP payload shape and add its fields to
  `portfolioFromRobinhoodRaw`.
