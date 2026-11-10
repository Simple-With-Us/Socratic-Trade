# 2026-08-15 — Durable strategy-run queue (202 + run id)

## Summary

Manual Run-once no longer races `runStrategyOnce()` against an 8s window with an
in-process detached promise.  The route persists a UUID first, returns **202
`queued`**, and a worker (route kick + scheduler drain) executes only that row.

A restart after the client has already been told the run started can no longer
lose the work.  Pre-LLM 412 gates stay synchronous.

## Why

Cloudflare ~100s edge timeout + multi-minute LLM runs.  The previous 8s race
avoided 524 HTML-as-failure, but `trackDetached()` dies with the process.

## Files

- `src/lib/strategy-run-requests.ts` — queue / claim / receipt
- `src/lib/db.ts` — migration 82 `strategy_run_requests`
- `app/api/strategy/run/route.ts` — persist-then-202 + GET `?runId=`
- `src/lib/scheduler.ts` — drain
- `src/lib/strategy.ts` — optional `runId` so the durable id matches the run row
- `app/console/components/chrome.tsx` — treat `queued` like `started`
- `src/lib/account-deletion.ts` — sweep the table; block delete while queued/running
- `test/strategy-run-once-async-route.test.ts` — durable contract

## Verify

`npx vitest run test/strategy-run-once-async-route.test.ts test/persistence-hardening.test.ts`
