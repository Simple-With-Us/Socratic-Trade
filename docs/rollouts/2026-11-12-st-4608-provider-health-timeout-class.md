# ST-4608 — Provider timeouts are transient health blips

## Context & Objective

Keyless provider timeouts were paging as hard connection failures.  Sentry issues SOCRATIC-TRADE-3K, SOCRATIC-TRADE-3M, SOCRATIC-TRADE-3R, and SOCRATIC-TRADE-3D are connection-failed events whose reason is a named timeout (Nasdaq's "timed out waiting for api.nasdaq.com.", plus AbortError, TimeoutError, and undici header or body timeouts).  ST-3079 already treats a bare `fetch failed` as transient-network.  Those timeout shapes missed both the expected-limit list and the transport-blip list, so a keyless lane captured them at error.

## Changes Made

The health classifier in `src/lib/db-health.ts` now treats a named provider timeout as a transport blip.  A short burst is a warning with `failureClass` `transient-network`, the `:transient` cooldown key, and no operator push.  The same streak still escalates to error after `HEALTH_TRANSIENT_ESCALATION_MS`.  HTTP 401, 403, and 5xx stay hard.  A bare caller-budget abort (`This operation was aborted`) stays an expected limit.  Strategy RAG deadlines stay caller timeouts.

- `src/lib/db-health.ts` — `isProviderTimeoutHealthText` and the log stamp.  Named timeouts win over a caller's `soft: true` flag so a TimeoutError is not stored as an expected limit.
- `test/provider-health-timeout-classification.test.ts` — Nasdaq message, AbortError, TimeoutError, undici timeout codes, escalation, HTTP 401/500, and per-user lanes.
- `test/transient-network-resilience.test.ts` — a named AbortError is no longer an expected limit.  The message-only budget abort stays soft.

Quote, scan, screener, order, and strategy fetch code is untouched.  `isTransientNetworkError` is untouched, so retry behavior does not change.

## Decisions & Trade-offs

Classification lives in the health layer only.  Open PRs already edit `nasdaq-screener-fetch.ts`, `data-source-fetch.ts`, `proxy-fetch.ts`, `market.ts`, and `data-providers.ts`.  Importing `NASDAQ_SCREENER_TIMEOUT_MESSAGE` into `db-health.ts` would cycle through those fetch modules, so the matcher uses the phrase `timed out waiting for`, which is that constant's text.

A row that names `AbortError` or `TimeoutError` counts toward the hard streak and can escalate.  The quote-cascade budget abort is stored as `This operation was aborted` without that name, and it stays soft so five budget cancels do not page.  An HTTP status is rejected before the timeout phrases, so a 500 body that says `timed out waiting for` stays hard.

No phase doc owns this classifier.  The 2026-09-08 transient-network rollout remains the design for the blip window.

## Verification State

```bash
npx vitest run test/provider-health-timeout-classification.test.ts test/transient-network-resilience.test.ts test/health-transient-network-classification.test.ts test/rag-deadline-timeout-classification.test.ts
```

`npx tsc --noEmit` is clean on Node 26.13.1.  `npm run lint` is 0 errors and 869 grandfathered warnings.  Focused vitest (the four files above) passed, 41 tests.  Full `npm test` is 10233 passed, 41 skipped, and 18 failed across 12 files.  None of those failures are in the health classifier.  They are injected credentials and host detection on this VM: `gh` 401 on the auto-merge pin, Pushover and LLM keys present where a test expects none, and `usesLocalHost` false.  `npm run build` completed (Next.js 16.4.5).  The first attempt aborted at the default heap limit.  The retry used `NODE_OPTIONS=--max-old-space-size=5120`.

## Next Steps & Blockers

Open the PR against `main`.  Do not merge, do not enable auto-merge, and do not deploy.  `verify` CI is the gate.  GB-Trader already holds the Linear claim.  This seat did not take it.

## Zero-Code Findings

`fetchWithRetry` logs `error.message` and sets `soft: true` for every AbortError.  The Nasdaq screener timeout is a plain `Error` whose message does not match that abort check, which is why SOCRATIC-TRADE-3K landed as `failureClass` hard.  Alpaca's deadline text is `Alpaca broker call timed out`, logged from `trackHealth` without the soft flag.
