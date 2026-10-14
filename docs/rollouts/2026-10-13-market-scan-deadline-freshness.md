# Market scan deadline and freshness

## Context

On 2026-10-13 the recent audit window (100 rows) had zero `market_scan` and zero `market_scan_failed` rows.  The last interactive or scheduled market scan stamp in production was 2026-10-12 06:29Z.  The scheduler itself was ticking and `marketOpen` was true.  2026-10-12 was a Monday and 2026-10-13 was a Tuesday, so a weekend or market-hours gate is not the cause.

## Root cause

Two writers persist `market_scan`: `GET /api/scan` and the `market_scan_freshness` scheduler lane.

The freshness lane hardcoded user id `local`.  The dashboard reads `market_scan` for the signed-in user.  Apple sign-in users never received a scheduled scan.

The Nasdaq screener fetch did not honor the caller abort signal.  Its 15s timer covered headers only and was cleared before `response.json()`.  A stalled body never rejected.  Freshness did not wrap `withScanDeadline`, so `runScanSingleFlight` kept that hung promise and later ticks attached to it.  The catch only logged.  It did not write `market_scan_failed`.

Interactive `/api/scan` already rejected at 35s and wrote `market_scan_failed`, then returned 500 or 503.  Those rows fall out of an all-kind last-100 window while strategy runs (5 to 12 minutes each) keep writing `strategy_run`.

The lane is not gated by `isRunAllowedNow` or `isTradingDay`.  `isTradingDay` only chooses full enrichment versus skip-enrichment plus a seed.

## Changes

- The screener fetch and the JSON body use the parent abort signal.  A parent abort is not retried.  The 15s header timeout still retries once.
- `GET /api/scan` still audits `market_scan_failed` on a failed refresh.  When a usable last-good scan exists it returns HTTP 200 with `stale: true`, `staleReason`, and the last-good `generatedAt`.  The 503 `scan_quotes_unavailable` shape remains only when no last-good exists.  Other errors with no last-good stay HTTP 500.
- Freshness walks `listUsers()`, wraps each scan in `withScanDeadline` (10 minutes), and audits `market_scan_failed` with source `market_scan_freshness` on reject or an empty quote scan.  The fast-gate cache is per user.

## Decisions

A rolling store of daily closes for `weekly-market-digest.ts` was skipped.  Free-tier Massive grouped bars still 403 on older history, and the existing fallback is per-symbol daily OHLC with a small budget.  A new table, backfill, and scheduler are a separate lane.

A same-thread event-loop stall can still delay timers until the stall ends.  The deadline fixes I/O hangs and the singleflight pin.  It does not preempt a multi-minute synchronous strategy run.

## Review follow-up

Open Sentry and Kody threads on this branch:

- `GET /api/scan` resolves identity before the scan `try`.  A 401/403/409 from `resolveRequestUserId` (deleted-account fence, live-bootstrap refusal) returns that status and does not serve user `local`'s last-good scan or audit the failure as `local`.
- Each user's enrichment `deadlineAt` is `Date.now() + FRESHNESS_SCAN_DEADLINE_MS` when that scan starts.  The tick timestamp stays the staleness clock only.
- Users refresh with a concurrency cap of 4.  One hung singleflight cannot block the rest of the lane.  `runScanSingleFlight` still coalesces same-user duplicates.
- `recordScanFailure` skips a row when the same freshness message is already the open outage inside the freshness window.  A newer `market_scan` ends the outage, so the next failure is recorded again.
- A successful `market_scan` primes `lastUsableAuditRowId` from `newestPersistedMarketScan` so the next tick can hit the fast gate.
- The Nasdaq screener body is parsed with `NasdaqScreenerPayloadSchema` before it is indexed, cached, or returned.  Unknown provider keys are stripped.  A drifted envelope throws and is not cached.

## Verification

- npm run lint -> ok (0 errors; 866 grandfathered warnings)
- npx tsc --noEmit -> ok
- npm test -> fail (2 unrelated; see below)
- npm run build -> ok

Targeted: `npx vitest run test/nasdaq-screener-schema.test.ts test/market-scan-freshness.test.ts test/scan-empty-screener.test.ts test/scan-singleflight.test.ts` passed (67 tests).

Full `npm test`: `Test Files 2 failed | 819 passed | 1 skipped (822)`, `Tests 2 failed | 9269 passed | 51 skipped (9322)`.  Neither failure is in a file this change touches.

- `test/egress-guard.test.ts` real-DNS case: `discord.com` resolved to `198.18.0.1` in this sandbox, which the SSRF guard rejects.  The same failure happens in isolation.  This diff does not touch the guard.
- `test/event-loop-stall-hot-path.test.ts` timing case failed under the full-suite load (`fastMs * 4` was 300, slow path 121).  It passed when re-run alone.

Files: `app/api/scan/route.ts`, `src/lib/market-scan-freshness.ts`, `src/lib/market.ts`, `src/lib/nasdaq-screener-schema.ts`, `test/market-scan-freshness.test.ts`, `test/scan-empty-screener.test.ts`, `test/nasdaq-screener-schema.test.ts`, `STATUS.md`, `PLAN.md`, this note.

## Next

Ready for review.  Label `do-not-automerge` because `/api/scan` reads broker positions and quotes.  Do not merge from this lane.  Congress-share HTTP 500, RAG retrieval, and OpenRouter embed failures from the same production pass are not this change.
