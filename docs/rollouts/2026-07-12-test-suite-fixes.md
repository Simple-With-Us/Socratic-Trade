# 2026-07-12 Test Suite Un-Breakage & LLM Failover Verification

## Summary
Fixed failing test cases in `web-sources-sec.test.ts` and `order-replacement.test.ts` to unblock CI. Also finalized and verified the LLM failover UI.

## Why
- `web-sources-sec.test.ts` began failing ~30 days after `2026-06-12` because the mock Form 4 XML used a static date. The `mergeInsiderFilings` layer intentionally drops SEC filings older than 30 days, causing the tests that assert on data persistence to fail with "no records" once July 12 rolled around.
- `order-replacement.test.ts` was expecting the `replaceStaleLimitOrderWithMarket` concurrency gate to throw a `MarketReplacePreconditionError` promise rejection, but the code actually returns `{ status: "pending_cancel", reason: ... }`.
- We addressed user queries regarding the LLM failover feature, confirming that it is purely opt-in (empty array default), respects user configurations, and requires only 429/5xx errors to cascade.

## Files Touched
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `test/web-sources-sec.test.ts`
- `test/order-replacement.test.ts`

## Verification
- Verified that `npm run build`, `npx tsc --noEmit`, and `npm test` are 100% clean across the repository.
- Ran `bash scripts/land.sh` to land these changes onto the `main` branch.

## Follow-ups
- Check that the Next.js production app (`socratic-trade-prod`) successfully auto-deploys via Coolify after this PR is merged to `main`.
