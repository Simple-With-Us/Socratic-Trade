# 2026-11-12 - proxy gate slot leak

## Context & Objective

Unread proxied responses were holding a `ProxyConcurrencyGate` slot until the body settled or the caller aborted.  A non-ok response whose body was never read (Yahoo chart 404, v7 401/403, fetchWithRetry 429 retry) leaked that slot.  Four leaks filled the cap of 4 and every later proxied fetch starved.  This is the ST-3999 follow-up for that leak.  `yahoo-finance.ts` stays a minimal edit because GB-Trader owns that file through PR #5121 (ST-4591).

## Changes Made

The gate now releases a slot on its own.  After headers, a 20s idle timer abandons a body that nobody is reading, and a 20s max hold abandons a body that has not delivered a chunk.  A max hold that has already delivered a chunk releases the slot and leaves the stream up.  A `FinalizationRegistry` releases the slot if the response is collected, and it cancels the upstream only when no read is in progress.  The wrapped body uses a zero high-water mark so an unread response does not count as an active read.  Yahoo chart and v7 early returns cancel the unread body before they return or retry.  `fetchWithRetry` cancels the body before its HTTP 429 `continue`.  That function does not retry 5xx, so there is no 5xx `continue` to cancel.  An unread 5xx body on `dataSourceFetch` is bounded by the gate.  `fetchCancelingErrorBody` is an opt-in helper that cancels status >= 400 unless the caller sets `readErrorBody`.  It uses the fetch it is given.  It does not open the residential proxy, and `dataSourceFetch` does not call it.  `GET /api/proxy-use` now includes `gate.inFlight`, `gate.queued`, and `gate.oldestHoldMs`, and the handler records Sentry gauges plus one warning when the oldest hold exceeds 60s.

- `src/lib/proxy-fetch.ts`
- `src/lib/proxy-gate-alert.ts`
- `src/lib/yahoo-finance.ts`
- `src/lib/data-providers.ts`
- `src/lib/sentry-metrics.ts`
- `app/api/proxy-use/route.ts`
- `test/proxy-gate-slot-leak.test.ts`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

Idle and max hold are both 20s.  Idle resets when a chunk arrives and does not fire while a consumer read is waiting on the upstream.  Idle still abandons a body that pauses with no read in progress, which is the unread-body leak.  Max hold abandons a body only when it has delivered no bytes.  A body that has delivered a chunk keeps streaming after the slot is released.  The alert threshold stays 60s.  `oldestHoldMs` starts when the slot is granted, before headers, so a stuck header wait can pass 60s even though a post-header body is capped at 20s.  `fetchWithRetry` was not given a new 5xx retry.  That would replay provider calls, including non-idempotent ones, which this leak fix does not need.  No trading account state or config was changed.

## Verification State

- `npx tsc --noEmit` — exit 0.
- `npx eslint` on the touched files — exit 0 (pre-existing warnings only).
- `npx vitest run test/proxy-gate-slot-leak.test.ts test/proxy-fetch.test.ts test/proxy-concurrency-gate.test.ts` — 3 files, 47 passed after the Kody review fixes.  `test/data-source-fetch.test.ts` — 27 passed.
- `npm test` — full `vitest run`, 1468s.  10236 passed, 41 skipped, 18 failed in 12 files.  The new gate file is not among the failures, and a focused rerun of the gate cases passed.  `alpha-vantage-key-pool` "SAME chunk" fails the same way on unmodified `main` (fetch count 3 vs 2).  The other failures are this seat's injected credentials (`gh` 401, LLM and Pushover env, remote host metrics), not this diff.  `data-providers` "PER-CREDENTIAL" passed when rerun alone.
- `npm run build` — first attempt hit the default ~2GB V8 heap and aborted (exit 134).  Retry with `NODE_OPTIONS=--max-old-space-size=4096` exited 0, including `stamp-csp-static-hashes`.

## Next Steps & Blockers

Do not merge from this lane.  Kody's review is addressed in the follow-up commit.  The 60s alert stays, because `oldestHoldMs` starts at slot grant, and the route test does not Zod-parse its own handler.  GB-Fixer already holds the Linear claim, so this branch does not take a second claim.  Merging to `main` still follows the weekday RTH latch.

## Zero-Code Findings

`fetchWithRetry` continues only on HTTP 429.  The 429/5xx continue the brief names exists in `src/lib/web-sources/http.ts`, which uses global fetch and does not take a proxy-gate slot.
