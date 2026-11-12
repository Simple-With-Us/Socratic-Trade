# ST-4611 iOS transient 5xx Sentry noise and GET retry

## Context & Objective

Deploy-swap and Cloudflare 502/503/504 responses on idempotent mobile GETs (especially `/api/mobile/snapshot`) were auto-reported as Sentry `HTTPClientError` events (SOCRATIC-TRADE-31 / -30).  Narrow automatic capture, retry transient gateway codes on GETs, and report one fingerprinted event when retries exhaust.

## Changes Made

- `MobileAPIHTTPRetryPolicy.swift` (new): pure Swift retry/capture rules (status, method, Retry-After cap, backoff).
- `SentryTelemetry.swift`: split `failedRequestStatusCodes` to 500–501 and 505–599; `beforeSend` drops `HTTPClientError` for 502–504; `captureHTTPServerFailure` with fingerprint `["mobile-api", path, status]`.
- `MobileAPIClient.swift`: `transientAwareData` retries 502/503/504 on GET/HEAD; `marketScan` retries before `scan_quotes_unavailable` decode; simplified `get()` (retry lives in transport helper).
- `ios/SocraticTradeTests/MobileAPIHTTPRetryPolicyTests.swift`: policy unit tests.

## Decisions & Trade-offs

- Exhausted 502/503/504 failures are always reported once via `captureHTTPServerFailure`, even when `captureFailures: false` (snapshot retry path).
- Manual `captureHTTPServerFailure` is limited to 502–504.  500–501 and 505–599 stay with sentry-cocoa's automatic `HTTPClientError` capture, so one response never emits two events (Kody review).
- `/api/mobile/snapshot` passes `maxTransientRetries: 0`: `MobileStore.fetchSnapshotWithNetworkRetry` already owns its two-attempt budget, and nesting the transport retry would allow six requests and ~270s pending (Kody review).
- `marketScan` runs its retry loop in `marketScanAttempts`, which binds each attempt's `let data` / `let response` inside the loop body; assigning outer `let` values inside a loop fails Swift definite initialization.
- `marketScan` keeps a localized retry loop so 503 `scan_quotes_unavailable` bodies are still decoded before `requireSuccess` and are never captured.
- `DELETE` is not treated as idempotent for retry (mutating unregister paths).

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Swift XCTest: not run in Linux cloud seat; logic covered by `MobileAPIHTTPRetryPolicyTests` for hosted `ios-build` CI.  Kody fix pass: `swiftc -parse` clean on the touched files, and `MobileAPIHTTPRetryPolicyTests` (8 tests) passed against the policy file with Linux swiftc 6.4.2.

## Next Steps & Blockers

- Merge after `verify` + `ios-build` green on PR.
- Watch SOCRATIC-TRADE-31/-30 volume after ship.

## Zero-Code Findings

None.
