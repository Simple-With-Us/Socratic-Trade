# 2026-06-21 — TradingView webhook route tests

## Summary

Added `test/webhooks-tradingview.test.ts` — 9 tests covering every branch of the
`POST /api/webhooks/tradingview` handler (404, 403, pass-IP, 400, 401, 422, 500,
200 happy path, 200 deduped). Also updated `vitest.config.ts` to add the `@/`
path alias so tests can import the Next.js route file directly.

## Why

The route was fully implemented but had no unit tests. The spec required route-level
coverage with mocked module boundaries so that each HTTP status and `audit()` call
can be asserted in isolation without a live DB or TradingView connection. Paper-mode
safe — the route ingests signals only, places no orders.

## Files

- `test/webhooks-tradingview.test.ts` — new; 9 tests
- `vitest.config.ts` — added `resolve.alias` for `@/` → `./src/` so the route
  file (which uses `@/lib/db` and `@/lib/web-sources/technical`) resolves under
  vitest

## Verification

```
cd /Users/jay/apps/wt-webhook
npx tsc --noEmit          # exit 0, no errors
npm test                  # 61 files, 473 tests, all pass
```

Both commands ran clean.

## Follow-ups

None. The route is read-only from the brokerage's perspective; no further
integration test is needed at this stage.
