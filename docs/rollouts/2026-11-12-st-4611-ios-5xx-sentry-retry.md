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
- `/api/mobile/snapshot` splits one bounded budget between the two loops so they never compound (Kody review, two rounds).  `snapshotData` never retries transport errors; `MobileStore.fetchSnapshotWithNetworkRetry` owns those (2 attempts, `generation` checked between them).  A 502/503/504 gets exactly one transport retry on the store's first attempt and none on its second, and the store never retries a `.serverError`, so a gateway failure that survives its retry is terminal and reported once.  Max requests per refresh: 3 (`MobileAPIHTTPRetryPolicy.snapshotMaxRequests`; was 6 when nested, 2 before this PR).  Worst case (MobileStore passes a 45s timeout): a transport error ends a store attempt because `snapshotData` passes `maxNetworkRetries: 0`, and the second attempt makes one request (`maxGatewayRetries: 0`), so at most two requests can run to the timeout.  That is a fast 502, the gateway backoff (0.3s, or a Retry-After capped at 30s), a 45s timeout, the 1.5s store backoff, then another 45s timeout: about 92s, or about 122s with a 30s Retry-After.  Only a 502–504 that itself arrives just before the 45s idle timeout could exceed that, up to about 137s (167s with Retry-After); proxies normally return gateway errors promptly.  Snapshot 502–504 reports go through their own `OutageReportLatch.snapshot` (separate from the SSE latch), so one outage reports once even though every SSE failure schedules a snapshot reload.  A successful snapshot response resets it.  A typical deploy-swap 503 that answers fast adds about 0.3s and one request.
- `/api/scan` allows one retry (`marketScanMaxRetries = 1`) for both gateway codes and transport errors: at most 2 requests, about 100s worst case (2 × 50s), or about 130s with a 30s Retry-After.  The 503 `scan_quotes_unavailable` decode still runs on every response before the retry check.
- The SSE stream `/api/mobile/events` is not retried (MobileStore reconnects quietly), so `events()` reports a 502/503/504 from `requireSuccess` once through `captureHTTPServerFailure`.  Other 5xx stay with the automatic capture, keeping the 502–504-only manual invariant (Kody review).  Because MobileStore reconnects after every failure, the report goes through `OutageReportLatch.events` (NSLock-guarded, shared by every client copy): only the first 502–504 of an outage is reported, and a successful connect resets the latch (Kody review).
- Xcode project: `ios/project.yml` (XcodeGen) is the source of truth and globs `SocraticTrade/` and `SocraticTradeTests/`.  `ios-build` runs `xcodegen generate` before build and test, and the ship script regenerates too, so CI never builds the checked-in `project.pbxproj`.  The checked-in copy is already behind main (for example `MobileSessionHardening.swift` and `NYSEMarketSession.swift` aren't in it), and ios/CLAUDE.md forbids hand edits.  The new files are picked up by the globs; sync the checked-in copy from the `generated-pbxproj` artifact as the workflow comment describes.
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

Swift XCTest: not run in Linux cloud seat; logic covered by `MobileAPIHTTPRetryPolicyTests` for hosted `ios-build` CI.  Kody fix pass: `swiftc -parse` clean on the touched files, and `MobileAPIHTTPRetryPolicyTests` (14 tests) passed against the policy file with Linux swiftc 6.4.2.  `MobileAPIClientRetryTests` (stub URLProtocol request counts for snapshot and scan, SSE and snapshot one-report-per-outage) runs in hosted `ios-build`.

## Next Steps & Blockers

- Merge after `verify` + `ios-build` green on PR.
- Watch SOCRATIC-TRADE-31/-30 volume after ship.

## Zero-Code Findings

None.
