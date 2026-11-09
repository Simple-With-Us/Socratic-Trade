# 2026-07-12 — [codex-autofix] PR #1475 Codex review triage (2 rounds)

## Round 1 — 2026-07-12: Honor HTTP-date Retry-After values in 429 handling

### Summary
Codex reviewer (chatgpt-codex-connector[bot]) flagged a P2 finding on PR #1475: the existing
429 Retry-After handling in `src/lib/congress-stream.ts` only parsed delta-seconds via
`parseInt`, ignoring the legal HTTP-date format (RFC 7231 §7.1.3, e.g.
`Retry-After: Wed, 21 Oct 2015 07:28:00 GMT`).

### What changed (Round 1)
- Added `Date.parse()` fallback in `connectOnce()` when `parseInt` returns NaN
- Computed seconds-until-reset from the HTTP-date → `Date.now()` delta
- Error message format unchanged — the same `(Retry-After: {seconds})` string is emitted
- `runLoop()`'s existing regex `/HTTP 429 \(Retry-After: (\d+)\)/` continues to extract
  the correct backoff seconds without modification

### Thread status (Round 1)
- Codex thread `PRRT_kwDOS7mOVM6QLY92` — **RESOLVED**

## Round 2 — 2026-07-12: Record 429 rate-limit failures in api_health_log

### Summary
Codex reviewer (P2) flagged that 429 rate-limit failures were completely suppressed from
`api_health_log` via an `if (!isRateLimit)` guard in `runLoop()`, so the admin Connections/health
dashboard showed stale success data when the SSE feed was being rate-limited.

### Why
The guard was added to prevent noise, but `logApiHealth()` (in `db-health.ts`) already detects
`429|rate limit` in the error text and passes `{ skipSentry: true }` to `alertConnectionFailure`,
suppressing Sentry alerts while still recording the failure in the health database.

### What changed (Round 2)
- Removed the `if (!isRateLimit)` guard around the `logApiHealth` call in `runLoop()`
- All errors (including 429s) now unconditionally flow to `logApiHealth()`
- Backoff logic unchanged; 429s still set `state.backoffMs` based on Retry-After or 60s default
- Reorganized the catch block for clarity (log first, then set backoff)

### Files touched (Round 2)
- `src/lib/congress-stream.ts` — removed rate-limit guard, reorganized catch block

## Verification (both rounds)
- `npx tsc --noEmit`: clean (no errors)
- `npm test`: 349 files / 3896 tests passed
- `npm run build`: clean

## Thread status
- Codex thread `PRRT_kwDOS7mOVM6QLY92` (Retry-After HTTP-date) — **RESOLVED** (Round 1)
- Codex thread `PRRT_kwDOS7mOVM6QMUJI` (log SSE rate-limit failures) — **RESOLVED** (Round 2)
- Auto-merge re-enabled via `gh pr merge --squash --auto`

## Follow-ups
None. Both Codex findings on this PR have been addressed.
