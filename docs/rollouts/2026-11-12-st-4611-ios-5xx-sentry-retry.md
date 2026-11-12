# ST-4611 iOS transient 5xx Sentry noise and GET retry

## Context & Objective

Deploy-swap and Cloudflare 502/503/504 responses on idempotent mobile GETs (especially `/api/mobile/snapshot`) were auto-reported as Sentry `HTTPClientError` events (SOCRATIC-TRADE-31 / -30).  Narrow automatic capture, retry transient gateway codes on GETs, and report one fingerprinted event when retries exhaust.

## Changes Made

- `MobileAPIHTTPRetryPolicy.swift` (new): pure Swift retry/capture rules (status, method, Retry-After cap, backoff).
- `SentryTelemetry.swift`: split `failedRequestStatusCodes` to 500–501 and 505–599; `beforeSend` drops `HTTPClientError` for 502–504; `captureHTTPServerFailure` with fingerprint `["mobile-api", path, status]`.
- `MobileAPIClient.swift`: `transientAwareData` retries 502/503/504 on GET/HEAD; `marketScan` retries before `scan_quotes_unavailable` decode; simplified `get()` (retry lives in transport helper).
- `ios/SocraticTradeTests/MobileAPIHTTPRetryPolicyTests.swift`: policy unit tests.

## Decisions & Trade-offs

- Exhausted HTTP server failures are always reported once via `captureHTTPServerFailure`, even when `captureFailures: false` (snapshot retry path).
- `marketScan` keeps a localized retry loop so 503 `scan_quotes_unavailable` bodies are still decoded before `requireSuccess` and are never captured.
- `DELETE` is not treated as idempotent for retry (mutating unregister paths).

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Swift XCTest: not run in Linux cloud seat; logic covered by `MobileAPIHTTPRetryPolicyTests` for hosted `ios-build` CI.

## Next Steps & Blockers

- Merge after `verify` + `ios-build` green on PR.
- Watch SOCRATIC-TRADE-31/-30 volume after ship.

## Zero-Code Findings

None.
