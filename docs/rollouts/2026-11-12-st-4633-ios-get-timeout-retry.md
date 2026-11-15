# ST-4633: retry idempotent iOS GETs on NSURLError -1001

## Context & Objective

Sentry SOCRATIC-TRADE-2W is `NSURLErrorDomain` code -1001 on `GET /api/mobile/snapshot`.  A transport timeout is not an HTTP 5xx.  ST-4611 / PR #5142 covers transient gateway statuses and is not merged here.  This change retries the timeout itself so one slow origin is not an immediate client failure.

## Changes Made

Idempotent GET and HEAD calls through `MobileAPIClient.transientAwareData` retry after `URLError.timedOut` or `NSURLErrorTimedOut` (-1001).  `#5142` already retried every network error on that path; this change caps a transport timeout so a per-attempt wait at or above 45s gets one extra try, not two.  Short GETs still retry twice.  Timeouts and 5xx share one attempt counter.  POST, PUT, PATCH, and DELETE return the first timeout.  `/api/scan` stays on `#5142`'s `marketScanAttempts` loop (`marketScanMaxRetries` is already one extra try, matching the 50s cap) so a second timeout helper cannot double-retry that 50s path.  Snapshot network errors stay with `MobileStore.fetchSnapshotWithNetworkRetry` (`snapshotStoreMaxAttempts` is already two, matching the 45s cap); `snapshotData` still sets `maxNetworkRetries` to 0.  The long-lived events stream is left to its existing reconnect loop.

- `ios/SocraticTrade/MobileAPITransportTimeoutRetry.swift`
- `ios/SocraticTrade/MobileAPIClient.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTradeTests/MobileAPITransportTimeoutRetryTests.swift`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

`#5142` landed first and already retries network errors, including -1001, inside `transientAwareData` and `marketScanAttempts`.  This branch now only caps that shared budget for transport timeouts (`networkRetryBudget`) instead of wrapping a second loop.  Market scan is left on `marketScanAttempts` alone.  Snapshot timeouts stay in the store loop so `generation` can be checked between attempts.  HEAD is included because it is safe to repeat.  OPTIONS is unused.  The load test restores the snapshot cache keys it clears.  The events stream stays out: its idle timeout is 120s and `MobileStore.startEvents` already reconnects.  `AppUpdatePrompt` talks to the App Store lookup host on `URLSession.shared`, not this client.  Sentry still records the timeout after the budget is spent.  Per-attempt timeouts are not captured.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
NODE_OPTIONS=--max-old-space-size=4096 npm run build
```

`npm run lint` exited 0 (869 existing warnings, 0 errors).  `npx tsc --noEmit` exited 0.  `npm run build` exited 0 after the default V8 heap aborted the first attempt.  `npm test` exited 1: 18 failed, 10248 passed, 41 skipped, across 12 files (`chat-llm`, `red-team`, `lesson-vectors`, `data-providers`, `alpha-vantage-key-pool`, `openrouter-credits`, `framework-review`, `notify-user-creds`, `notify-body-tiers`, `persistence-notification`, `server-metrics`, `automerge-reusable-pin`).  None of those files are in this diff.  Swift compile and `MobileAPITransportTimeoutRetryTests` run on hosted `ios-build` (`.github/workflows/ios-build.yml`).  This seat cannot run `xcodebuild`.  The new tests fail on the old client: a short snapshot GET that times out twice then returns 200 used to stop on the first timeout.  `load()` uses the 45s timeout, so a persistent timeout stops after two attempts and `isRefreshing` is false.  Market scan stops after two attempts as well.  This follow-up is Swift only.  The earlier Node gate on this branch still stands: lint and `tsc --noEmit` exited 0, `npm run build` exited 0 with a 4GB heap, and `npm test` had 18 failures in unrelated files.

## Next Steps & Blockers

PR #5175 is open.  Do not merge, do not enable auto-merge, and do not deploy.  Wait for `verify` and `ios-build` on the shared-budget commit.  Kody flagged the stacked `get` budget, the default-argument name, and the cache-key leak.  This commit is that fix.

## Zero-Code Findings

PR #5142 has merged.  `transientAwareData` already retries every network error on idempotent reads, including -1001, and `marketScanAttempts` already retries network errors once.  The remaining ST-4633 work is the 45s timeout cap on that shared budget, not a second retry loop.
