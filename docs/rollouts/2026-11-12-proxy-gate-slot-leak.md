# 2026-11-12 - proxy gate slot leak

## Context & Objective

Unread proxied responses were holding a `ProxyConcurrencyGate` slot until the body settled or the caller aborted.  A non-ok response whose body was never read (Yahoo chart 404, v7 401/403, fetchWithRetry 429 retry) leaked that slot.  Four leaks filled the cap of 4 and every later proxied fetch starved.  This is the ST-3999 follow-up for that leak.  `yahoo-finance.ts` stays a minimal edit because GB-Trader owns that file through PR #5121 (ST-4591).

## Changes Made

The gate now releases a slot on its own.  After headers, a 20s max hold and a 20s idle timer both call the same settle path, and a `FinalizationRegistry` releases the slot if the response is collected first.  The wrapped body uses a zero high-water mark so an unread response does not count as an active read.  Yahoo chart and v7 early returns cancel the unread body before they return or retry.  `fetchWithRetry` cancels the body before its HTTP 429 `continue`.  That function does not retry 5xx, so there is no 5xx `continue` to cancel; an unread 5xx body is bounded by the gate, and `proxiedFetch` cancels status >= 400 unless the caller sets `readErrorBody`.  `GET /api/proxy-use` now includes `gate.inFlight`, `gate.queued`, and `gate.oldestHoldMs`, and the handler records Sentry gauges plus one warning when the oldest hold exceeds 60s.

- `src/lib/proxy-fetch.ts`
- `src/lib/yahoo-finance.ts`
- `src/lib/data-providers.ts`
- `src/lib/sentry-metrics.ts`
- `app/api/proxy-use/route.ts`
- `test/proxy-gate-slot-leak.test.ts`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

Idle and max hold are both 20s.  Idle resets when a chunk arrives and does not fire while a consumer read is waiting on the upstream.  Max hold still releases a slot that is actively waiting.  Forced release also cancels the upstream so the proxy socket is not kept.  `fetchWithRetry` was not given a new 5xx retry.  That would replay provider calls, including non-idempotent ones, which this leak fix does not need.  No trading account state or config was changed.

## Verification State

- `npx tsc --noEmit` — exit 0.
- `npx eslint` on the touched files — exit 0 (pre-existing warnings only).
- `npx vitest run test/proxy-gate-slot-leak.test.ts test/proxy-fetch.test.ts test/proxy-concurrency-gate.test.ts test/data-source-fetch.test.ts` — 4 files, 73 passed.
- `npm test` — full `vitest run`, 1468s.  10236 passed, 41 skipped, 18 failed in 12 files.  The new gate file is not among the failures, and a focused rerun of the gate cases passed.  `alpha-vantage-key-pool` "SAME chunk" fails the same way on unmodified `main` (fetch count 3 vs 2).  The other failures are this seat's injected credentials (`gh` 401, LLM and Pushover env, remote host metrics), not this diff.  `data-providers` "PER-CREDENTIAL" passed when rerun alone.
- `npm run build` — first attempt hit the default ~2GB V8 heap and aborted (exit 134).  Retry with `NODE_OPTIONS=--max-old-space-size=4096` exited 0, including `stamp-csp-static-hashes`.

## Next Steps & Blockers

Do not merge from this lane.  Kody reviews.  GB-Fixer already holds the Linear claim, so this branch does not take a second claim.  Merging to `main` still follows the weekday RTH latch.

## Zero-Code Findings

`fetchWithRetry` continues only on HTTP 429.  The 429/5xx continue the brief names exists in `src/lib/web-sources/http.ts`, which uses global fetch and does not take a proxy-gate slot.
