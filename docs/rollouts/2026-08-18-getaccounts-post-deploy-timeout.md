# 2026-08-18: Survive a slow first `getAccounts` after a deploy swap

## Context & Objective

After HOTFIX #2831 went live (squash `581467e1`, `processStartedAt` 2026-08-18T21:12:26Z), Manual Run once on Paper and Roth failed with `Timed out waiting for gateway.getAccounts after 6000ms`.  Same Alpaca credentials had completed Roth at 19:43Z on the previous process.  Goal: find the actual fail site, then make Run once survive a slow or hung first account read without hiding a real broker-down.

## Changes Made

Live ops snapshot (`asOf` 2026-08-18T21:37:42Z) plus the code path:

- The exact 6000ms string is only produced by `getDashboardSnapshot`.  Console Run once preflights `accountReadiness`.  A timeout sets `brokerAccountReadError`, readiness fail-closes, and the Run once sheet shows that string.  No new strategy run was queued after 21:12Z.
- Paper (`PA33IDTHMFK9`) and Roth (`294709855`) are `broker: alpaca` REST, not `alpaca-mcp`.  Trading Ops' hung-MCP hypothesis is not the account type in play.  Alpaca REST `getAccount` is frequently slower than 6s (timeouts also at 14:54Z, 20:02Z, 20:15Z before this swap, and 21:31–21:36Z after).
- Strategy `runStrategyOnce` itself has no 6s `getAccounts` deadline.  The hard-fail is the dashboard race plus readiness.

Runtime fix (not error-copy, not a Coolify bounce):

- Shared `awaitWithFirstCallRetry`: if the first call is still pending at the original budget, start one fresh call and wait the grace window.  A thrown credential / 401 error is not retried.
- Dashboard `getAccounts` uses 6s + 9s.  The sequential portfolio bundle uses 8s + 7s (same readiness fail-close on the 8s timeout).
- Alpaca REST `getAccount` used by `getAccounts` / `getPortfolio` uses 5s + 10s so a hung first SDK socket can recover on the strategy-run path too.
- Alpaca MCP `fetch` now carries `AbortSignal.timeout(8000)` so a hung sidecar falls back to REST instead of pinning the read.

Files:

- `src/lib/inflight-deadline.ts`
- `src/lib/dashboard.ts`
- `src/lib/alpaca.ts`
- `test/inflight-deadline.test.ts`
- `test/alpaca-mcp.test.ts`
- `test/dashboard-agentic-fallback.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `PLAN.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-08-18-getaccounts-post-deploy-timeout.md`

## Decisions & Trade-offs

- Did not ignore a timeout in `accountReadinessForSnapshot`.  After 15s with no settlement, readiness still fail-closes.  That is a real broker-down, not a hide.
- Did not raise every dashboard deadline (quotes, macro).  Only the two readiness-blocking broker reads.
- Did not bounce Coolify.  Did not touch #2841, #2840, #2812, or trading strategy logic.
- Nested retry (dashboard + Alpaca `readAccount`) can start extra GETs.  Bounded at two layers, cheaper than a wedged Run once.

## Verification State

Focused tests first; full gate after the PR opens.

```
npx vitest run test/inflight-deadline.test.ts test/alpaca-mcp.test.ts test/dashboard-agentic-fallback.test.ts
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Did not click production Run once (do not deploy).  Did not bounce Coolify.

## Next Steps & Blockers

- Merge when verify is green.  Do not deploy from this PR by hand (auto-deploy on main).
- After merge, confirm a Paper + Roth Manual Run once no longer sheets the old 6000ms string solely because the first `getAccount` took >6s.
- Left: why Alpaca REST from Hetzner is often >6s (origin, keep-alive, DNS).  This PR survives that; it does not make Alpaca fast.

## Zero-Code Findings

- Discarded "missing credential after swap": same keys, Roth completed 19:43Z, Paper last run 19:33Z.
- Discarded "only first 2 minutes after boot": timeouts continue at 21:31–21:36Z (19+ minutes after `processStartedAt`).
- Discarded "strategy.ts 6s deadline": there is none.  The user-visible fail is dashboard readiness.
