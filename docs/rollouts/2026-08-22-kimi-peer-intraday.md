# 2026-08-22 — Kimi leftover: CT peer intraday stored-token path

## Why

Retired-KIMI ST #3044 (`cursor/kimi-audit-def`) was CONFLICTING and mixed a real security/correctness slice with CI/lockfile/png churn already on `main`.  Re-land only the unique piece so Congress.Trade peer backfill does not use a live env-token bypass.

## What

- `fetchIntradayBars(..., { operatorPeerRead })` uses the operator (`local`) *stored* MCP token, not `process.env.ROBINHOOD_MCP_AUTH_TOKEN`.
- The token-gated peer route `/api/market/intraday` is the only caller that sets `operatorPeerRead: true`.
- Comments in `robinhood.ts` match: env is a boot seed via `migrateLocalRobinhoodToken`.

Dropped from #3044: `npm ci` / pin-check / dependabot / gh CLI pin (already on main, pin-check is now `.mjs`), accidental branding PNG deletes, package-lock SHA churn.

Aug 13 uncommitted `broker-status-conformance` patch is already on main.  Do not reapply.

## Verify

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npx vitest run test/market-realtime.test.ts test/market-intraday-route.test.ts
```

21/21 passed in the lane.

## Follow-ups

- Close ST #3044 as superseded once this PR merges.
- Coordinator #93 already merged (janitor idle-check; do not substring-match `kimi`).  Live janitor copied.
