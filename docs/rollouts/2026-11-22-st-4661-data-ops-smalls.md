# ST-4661 data/ops smalls (2026-11-22, Muse Code MC)

## Context & Objective
Three small, independently provable slices from the ST-4650 sweep's data/ops batch.  The remaining items on ST-4661 (cascade wave parallelization, MarketScan.source format, MAE/MFE range API, per-candidate episodic sketches, test sharding, e2e required-check status) deliberately stay open — each needs its own design.

## Changes Made
- `src/lib/data-providers.ts`: `fetchWithRetry` retries a transient 5xx within the same logical call, mirroring the 429 branch (same retries budget, capped Retry-After, no intermediate health/telemetry row).  Gated to replayable methods (GET/HEAD/OPTIONS) or explicit `retryNonIdempotent`, because a 5xx may mean the far side processed the request; skipped when the caller signal already fired; the final 5xx `Response` is still returned unchanged after exhaustion.  Caller audit: every exact-quota/durable-attempt caller passes `retries: 0`, so no uncounted attempt hides inside a reservation.
- `src/lib/db.ts`: v22 `order_replacements` rebuild copies 17 explicitly named columns instead of `SELECT *`.  On a real pre-v22 layout (v20 ALTER-appended columns) the old positional copy scrambles values and fails the rebuilt table's status CHECK outright — a live migration bug, regression-pinned by restoring `SELECT *` in the test.
- `test/fetch-with-retry-5xx.test.ts`, `test/db-migration-v22-order-replacements.test.ts` (new); `test/exit-guard.test.ts`: child-process probe spawning the real `installProcessExitGuard` path under `NODE_ENV=production` (spontaneous exit 0 observed as OS code 43, SIGTERM as 143).  No production change for the probe, no test-only exports.

## Decisions & Trade-offs
- Behavior delta to know: default-retries callers now make up to 2 upstream calls on transient 5xx (latency + one extra call on upstream failure); exact-quota lanes are unaffected (`retries: 0`).
- Timeout audit anchor closed with no caller change: every AbortController site already clears its timer in `finally` and forwards its signal; the new 5xx branch refuses to retry on an already-fired signal instead.

## Verification State
- Writer lane: fetch-5xx 6/6, v22 migration 1/1 (with negative SELECT-* check), exit-guard 11/11, adjacent suites 101/101; tsc clean; eslint 0 errors.
- Parent on harvested tree: full `npm run lint` 0 errors, `npx tsc --noEmit` clean, targeted vitest 8 files / 119 tests passed, `npm run build` exit 0.  Full serial suite runs in CI verify.

## Next Steps & Blockers
- Land after #5436 (same `data-providers.ts`, disjoint hunk) with the combined fetch/circuit-breaker reruns on the merged tree.

## Zero-Code Findings
- No dead AbortController or leaked timer exists in current `main` (audit anchor verified, no change made).
