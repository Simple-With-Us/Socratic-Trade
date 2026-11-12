# ST-4633: retry idempotent iOS GETs on NSURLError -1001

## Context & Objective

Sentry SOCRATIC-TRADE-2W is `NSURLErrorDomain` code -1001 on `GET /api/mobile/snapshot`.  A transport timeout is not an HTTP 5xx.  ST-4611 / PR #5142 covers transient gateway statuses and is not merged here.  This change retries the timeout itself so one slow origin is not an immediate client failure.

## Changes Made

Idempotent GET and HEAD calls through `MobileAPIClient` try the request again twice after `URLError.timedOut` or `NSURLErrorTimedOut` (-1001), with a 300ms then 600ms backoff.  POST, PUT, PATCH, and DELETE return the first timeout.  `get` still retries other network errors and HTTP status codes at or above 500.  Snapshot load no longer starts a second timeout budget after the client budget is spent.  The long-lived events stream is left to its existing reconnect loop.

- `ios/SocraticTrade/MobileAPITransportTimeoutRetry.swift`
- `ios/SocraticTrade/MobileAPIClient.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTradeTests/MobileAPITransportTimeoutRetryTests.swift`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

The retry lives next to `URLSession.data` so snapshot, scan, quote, and the other idempotent reads share one rule.  HEAD is included because it is safe to repeat.  OPTIONS is unused.  The events stream stays out: its idle timeout is 120s and `MobileStore.startEvents` already reconnects.  `AppUpdatePrompt` talks to the App Store lookup host on `URLSession.shared`, not this client.  Sentry still records the timeout after the budget is spent.  Per-attempt timeouts are not captured.  No phase doc owns this helper.  ST-4611's `MobileAPIHTTPRetryPolicy` is a separate open branch.  If that branch lands first, keep a single network-retry loop so a timeout is not retried by both helpers.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
NODE_OPTIONS=--max-old-space-size=4096 npm run build
```

`npm run lint` exited 0 (869 existing warnings, 0 errors).  `npx tsc --noEmit` exited 0.  `npm run build` exited 0 after the default V8 heap aborted the first attempt.  `npm test` exited 1: 18 failed, 10248 passed, 41 skipped, across 12 files (`chat-llm`, `red-team`, `lesson-vectors`, `data-providers`, `alpha-vantage-key-pool`, `openrouter-credits`, `framework-review`, `notify-user-creds`, `notify-body-tiers`, `persistence-notification`, `server-metrics`, `automerge-reusable-pin`).  None of those files are in this diff.  Swift compile and `MobileAPITransportTimeoutRetryTests` run on hosted `ios-build` (`.github/workflows/ios-build.yml`).  This seat cannot run `xcodebuild`.  The new tests fail on the old client: a snapshot GET that times out twice then returns 200 used to stop on the first timeout, and a load that only times out used to stop after two attempts instead of the three-attempt budget.

## Next Steps & Blockers

Open a ready PR against `main`.  Do not merge, do not enable auto-merge, and do not deploy.  Wait for `verify` and `ios-build`.

## Zero-Code Findings

PR #5142 already retries every network error on idempotent reads inside `transientAwareData`, including -1001, but that pull request is still open and is not the base of this branch.  `main` retries timeouts only for `get` and for the store's snapshot loop.  `marketScan` and `successfulResponseData` did not.
