# 2026-11-11 — ST-4599 snapshot first, then live quotes

## Context & Objective

Jay's decision on ST-4599: when the Nasdaq screener is down and a saved snapshot exists, the interactive scan shows that snapshot immediately, labeled with how old it is, and then updates when live recovery returns.  If live recovery fails, the snapshot stays, still labeled with its age.  This is the answer to the open seed-order review on `src/lib/market.ts`: show the snapshot first, and still run Yahoo then broker.  ST-3999 stays intact.  Freshness still passes `allowWholeSetYahooFallback: false`, and the priority proxy lane and quote-outage backoff are unchanged.

## Changes Made

The interactive `GET /api/scan` path sets `previewSeedBeforeLiveRecovery`.  When the screener returns no rows, or the fetch throws, and a usable seed has an as-of time, the handler returns that ranked snapshot at once with `pricesAsOf`, `refreshPending`, and a `recoveryId`.  It does not audit the snapshot as a new market scan.  Yahoo whole-set pricing, then broker recovery, continues in the background with the screener skipped so a last-good screener cache cannot look live.  The client asks `GET /api/scan?recovery=<id>` for the same user.  A live scan replaces the snapshot.  A failure body keeps it.

The blocking helper `recoverQuotesWhenScreenerEmpty` is still Yahoo, then broker, then seed.  Callers that do not set the preview flag, including freshness, keep that order and do not return early.

The website Scan header and the line above the price table say `Prices as of 2:14 PM, 23 min old` in Central time, and `Updating with live prices.` while the follow-up is in flight.  iOS Scan uses the same sentence as the Market Scan subtitle.  The age is hidden when a newer completed strategy scan is the table on screen.

- `src/lib/scan-seed-preview.ts`
- `src/lib/market.ts`
- `src/lib/types.ts`
- `app/api/scan/route.ts`
- `app/console/scan/use-live-scan.ts`
- `app/console/scan/page.tsx`
- `ios/SocraticTrade/DeskModels.swift`
- `ios/SocraticTrade/MobileAPIClient.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/ScanView.swift`
- `ios/SocraticTradeTests/DeskModelsTests.swift`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `test/scan-seed-preview.test.ts`
- `test/scan-route-account-scope.test.ts`
- `test/market-scan-freshness.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-4-market-data-scoring.md`

## Decisions & Trade-offs

The preview is a ranked copy of the seed, not a second full finalize, so stale prices are not written as a fresh `market_scan`.  The follow-up scan is the one that is audited, after broker quotes and grouped bars.  The recovery id is a UUID bound to the user who started the scan.  A missing or other-user id is 404.  A seed with no resolvable as-of time does not preview, because the age could not be labeled honestly.  A live screener that misses this universe does not preview.  The inner recovery passes no seed, so a failed Yahoo and broker path throws instead of returning the seed as a scan stamped now.

## Verification State

`NODE_OPTIONS=--max-old-space-size=4096 npm run build` exited 0.  The first `npm run build` aborted at the default heap limit (exit 134) before typecheck of the pages.  `npx tsc --noEmit` exited 0.

`npm run lint` exited 0 (0 errors, 867 grandfathered warnings).

`npm test` (`vitest run`) finished 10212 passed, 18 failed, 41 skipped, across 898 files.  The 18 failures are outside this change: chat, notify, lesson-vector, and host-metadata tests that expect no provider key or a local-host flag, and they fail as `OpenAILLM` or `usesLocalHost` mismatches in this environment.  None of the failing files are the scan snapshot files.  `test/scan-seed-preview.test.ts`, `test/scan-route-account-scope.test.ts`, `test/scan-empty-screener.test.ts`, and `test/market-scan-freshness.test.ts` passed in the earlier focused run and are not in the full-suite failure list.  iOS Swift was not compiled here.

## Next Steps & Blockers

PR #5125 stays the delivery PR.  Do not mark ST-4599 completed until it merges.  iOS compile is `.github/workflows/ios-build.yml` on GitHub-hosted macOS.  This seat did not run `xcodebuild`.

## Zero-Code Findings

None.  The behavior change is in the files above.
