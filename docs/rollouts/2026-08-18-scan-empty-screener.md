# 2026-08-18 — Nasdaq screener UA + retry so Scan returns names

## Context & Objective

Get Scan to return ranked names again.  Every scan since 2026-08-13T22:30Z had 0 quotes because `fetchNasdaqScreener` still used stub `"Mozilla/5.0"` and an 8s `abort()`.  Last good was 513 quotes.  This is a transport fix, not empty-state copy.

## Changes Made

Verified abort cause: `fetchNasdaqScreener` `setTimeout(() => controller.abort(), 8000)` with no reason, left armed through `response.json()` of the 8000-row table, UA only `"Mozilla/5.0"`, no Origin/Referer, no `fetchWithRetry`.  Node/undici reports that as “This operation was aborted.”  The 20s interactive deadline uses a different message (“Interactive market scan deadline exceeded.”).  Cache is written only on success, so every scan re-hit and re-aborted.  Sibling nasdaq-calendar + nasdaq-quote already used `BROWSER_UA` + Origin/Referer + `fetchWithRetry({ retries: 1 })` after 2026-08-05 (`docs/rollouts/2026-08-05-soft-health-and-nasdaq-ua.md`).  The screener was never migrated.  `congress-share` `fetchNasdaqScreenerRefs` was the same 8s stub-UA duplicate.

Fix: `fetchNasdaqScreener` in `src/lib/market.ts` now calls `fetchWithRetry` with `BROWSER_UA` + Origin/Referer, matching nasdaq-quote / nasdaq-calendar.  15s timeout, one abort retry.  If Nasdaq still returns 0, Yahoo prices the whole allowed S&P set so ranking still produces names.

- `src/lib/market.ts` — `fetchNasdaqScreener` uses `BROWSER_UA` + Origin/Referer + `fetchWithRetry`; Yahoo whole-set
- `src/lib/nasdaq-screener-fetch.ts` — shared timeout/UA constants; congress-share uses the same helper
- `src/lib/congress-share.ts` — `fetchNasdaqScreenerRefs` uses the same helper
- `src/lib/scan-singleflight.ts` — `isUnusableEmptyMarketScan` (505 / 0 / 0 is not last-good)
- `src/lib/dashboard.ts` — skip empty abort audits when picking latestScan
- `src/lib/yahoo-finance.ts` — batch concurrency for the empty-screener fallback
- `app/api/scan/route.ts` — 503 + `market_scan_failed`; 35s interactive budget
- `app/console/scan/page.tsx`, `app/console/scan/use-live-scan.ts` — quote-miss copy; 503 warnings
- `ios/SocraticTrade/MobileAPIClient.swift` — decode 503 `scan_quotes_unavailable`; join warnings on `.scanQuotesUnavailable`
- `ios/SocraticTrade/MobileStore.swift` — exhaustive `MobileAPIError` switch includes `.scanQuotesUnavailable` (unsigned xcodebuild miss)
- `ios/SocraticTrade/DeskModels.swift`, `ios/SocraticTrade/ScanView.swift` — counts + warnings; no silent No Candidates on quote miss
- `ios/SocraticTradeTests/DeskModelsTests.swift`, `ios/SocraticTradeTests/UserFacingCopyTests.swift`
- `test/scan-empty-screener.test.ts`, `test/market-custom-symbol.test.ts`
- `docs/phase-4-market-data-scoring.md`, `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- 15s + one abort retry, not another 8s cut.  8s was the outage.  The interactive deadline is not wired into the Nasdaq fetch so a hang cannot become a silent empty `market_scan`.
- 503 rather than a 200 empty table.  A still-valid seed is the stale fallback it already was; `{}` / expired seed does not claim "showing the latest strategy scan."
- Empty `includedIndices` with no additional symbols and no holdings is a real empty universe (200 + Guardrails).  A 505-symbol abort is not.
- No coordinator notes in product UI.  No Stripe.  No OpenRouter spend.  Did not stack on #2829 / #2800 / reserved #2792 #2798 #2794.

## Verification State

```bash
npx vitest run test/scan-empty-screener.test.ts test/market-custom-symbol.test.ts
# 22 passed (abort → BROWSER_UA retry; empty seedEnrichment {} does not 200 cached; Yahoo whole-set)
npx eslint src/lib/nasdaq-screener-fetch.ts src/lib/market.ts src/lib/congress-share.ts app/api/scan/route.ts test/scan-empty-screener.test.ts
npx tsc --noEmit  # clean
```

Live recorded 2026-08-18 (market open), this VM:

- Nasdaq screener `BROWSER_UA` + Origin/Referer: HTTP 200, **7176** rows, asOf "Last price as of Aug 18, 2026".
- `scanMarket(SP500_SYMBOLS, [], …, { enrichmentMode: "skip" })`: **498 quotes / 502 scanned / 38 topCandidates**, source `nasdaq-delayed-screener`.
- After inlining `BROWSER_UA` + `fetchWithRetry` in `fetchNasdaqScreener`: `scanMarket([AAPL, MSFT, NVDA, JPM, GOOGL, XOM])` returned **6 quotes / 6 names** (AAPL, GOOGL, JPM, MSFT, XOM, NVDA), source includes `nasdaq-delayed-screener`.  Yahoo fallback was not needed.

Linux VM cannot compile Swift.  Unsigned Mac `xcodebuild` failed on `MobileStore.swift:697` missing `.scanQuotesUnavailable`; that case is now exhaustive.  Mac runner must go green.

PR **#2830**.  Rebased onto `origin/main` `7b073b65` (includes #2812 `12e8dcd` and #2832).  `git merge-tree --write-tree origin/main HEAD` is clean.  Did not revert #2812 / #2829 / #2800.  Does not block #2831.

## Next Steps & Blockers

- Compile iOS on a Mac (`xcodebuild` / TestFlight) before claiming the Scan tab visually.
- After merge, confirm prod writes populated `topCandidates` (or `market_scan_failed` if Nasdaq and Yahoo both miss), never a silent 505/0/0 `market_scan`.

## Zero-Code Findings

Receipt `d0359642` is an in-app 8s stub-UA abort of `nasdaq-delayed-screener` on sha `cda485ff`, then an empty/expired seed, then a successful `market_scan` 200.  iOS never decoded those warnings and told the user to check Guardrails.  `#2666` and `#2829` do not touch this path.
