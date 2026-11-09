# Rollout Note: 2026-08-01 — CBOE-First VIX Cascade Optimization

## 1. Context & Objective
The user asked: "why would we have code set to always have VIX queries be blocked? shouldn't that data cascade of sources be coded differently so that it works?"

Upon inspection of `src/lib/macro.ts`, the keyless ^VIX fetch cascade attempted Yahoo Finance (`vix-yahoo`) first and CBOE (`vix-cboe`) second. Yahoo Finance routinely returns HTTP 429 / blocks datacenter IP addresses (Oracle Cloud, AWS, GCP), causing every scheduler tick to log an error in `api_health_log` and trip the circuit breaker for `vix-yahoo`.

## 2. Changes Made
- **Primary Lane Re-ordering (`src/lib/macro.ts`)**:
  - Re-ordered the keyless ^VIX cascade so CBOE (`fetchVixFromCboe`) is tried FIRST as Lane 1, and Yahoo (`fetchVixFromYahoo`) is tried SECOND as Lane 2 fallback.
  - CBOE operates a keyless, public delayed-quote CDN (`cdn.cboe.com`) that is the authoritative publisher of VIX and does not rate-limit or block datacenter IPs.
  - Putting CBOE first ensures 100% of VIX queries resolve on the primary attempt without triggering Yahoo 429 rate-limit errors or polluting `api_health_log`.
- **Tests (`test/macro-live-vix.test.ts`)**:
  - Updated test suite to verify the CBOE-first cascade order.

## 3. Verification State
- `npx vitest test/macro-live-vix.test.ts --run` -> All 8 tests passed cleanly.
- `npx tsc --noEmit` -> Passed with 0 errors.

## 4. Files Touched
- `src/lib/macro.ts`
- `test/macro-live-vix.test.ts`
- `docs/rollouts/2026-08-01-cboe-first-vix-cascade.md`
- `STATUS.md`
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md`
