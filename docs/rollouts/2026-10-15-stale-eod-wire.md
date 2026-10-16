# Withhold stale EOD tails on the Congress.Trade wire (ST-3845)

## 1. Context & Objective

Congress.Trade treats a pushed close, and `closes[0]` on the pull, as the current price.  When every history provider misses, `fetchDailyOHLC` still returns `history-cache-eod-stale` or `imported-eod-stale` bars.  The shared `PriceSeries` schema has no provenance field, and Zod strips unknown keys before POST, so that stamp never reaches Congress.Trade.  PR #4009 stopped a stale dense import from beating a live source.  It did not stop a stale tail from being sent as current.

## 2. Changes Made

A series is fresh only when its newest close date is on or after `latestCompletedTradingSessionEtKey`.  Otherwise the nightly share omits that ticker and the S&P series, audits `congress_share_stale_price_withheld`, and counts `congress_share.stale_price_withheld`.  The pull routes return HTTP 502 `{ ok: false, error: "stale" }` for that tail.  A confirmed empty series stays HTTP 200.  A stale flat-file tail still tries the live cascade before it is withheld.

- `src/lib/congress-share.ts`
- `src/lib/market-read.ts`
- `src/lib/sentry-metrics.ts`
- `app/api/market/prices/[symbol]/route.ts`
- `app/api/market/spx/route.ts`
- `test/congress-share.test.ts`
- `test/market-read-routes.test.ts`
- `docs/congress-trade-share.md`
- `STATUS.md`
- `PLAN.md`

## 3. Decisions & Trade-offs

Dropping the series, rather than adding a provenance field, is the ST-only fix.  Congress.Trade's strict row schema would strip or reject an extra field, and `currentPriceDate` is already set but not validated downstream.  Historical closes inside a stale tail are withheld with it.  Replaying them would refresh Congress.Trade's receive-time watchdog.  A flat-file miss that the live cascade can refresh is still sent.

The first pull cut returned an empty 200 for a stale tail.  That matches a confirmed empty series, and Congress.Trade only falls back on non-200 (same contract as `GET /api/market/intraday`, which uses 502 for provider unavailable).  Sentry review on PR #4725 flagged it.  Stale pulls are now 502.  404 stays the missing-profile signal.  The push still omits the ticker rather than POSTing a failure.

## 4. Verification State

```bash
npx eslint src/lib/congress-share.ts src/lib/market-read.ts src/lib/sentry-metrics.ts test/congress-share.test.ts test/market-read-routes.test.ts
npx tsc --noEmit
npx vitest run test/congress-share.test.ts test/market-read-routes.test.ts
```

eslint on the touched files: 0 errors (existing unused-schema warnings only).  `npm run lint`: 0 errors, 856 grandfathered warnings.  `tsc --noEmit` clean.  Targeted vitest: 2 files, 132 tests passed.  Full `npm test`: 23 failed, 9368 passed, 51 skipped.  The 23 failures are in LLM-key, notify, alpha-vantage, and server-metrics suites, not the share or market-read tests.  `npm run build`: exit 0.

Sentry follow-up (stale pull is 502, confirmed empty stays 200):

```bash
npx eslint src/lib/market-read.ts 'app/api/market/prices/[symbol]/route.ts' app/api/market/spx/route.ts test/market-read-routes.test.ts
npx tsc --noEmit
npx vitest run test/market-read-routes.test.ts
npm run lint
```

Those commands passed, and `npm run build` on this follow-up exited 0.

- `npm run lint` -> pass (0 errors, 856 grandfathered warnings)
- `npx tsc --noEmit` -> pass
- `npm test` -> 23 failed, 9368 passed, 51 skipped on the prior commit.  Failures are LLM-key, notify, alpha-vantage, and server-metrics suites, outside this diff.  This follow-up re-ran `test/market-read-routes.test.ts`: 37 passed.
- `npm run build` -> pass (exit 0)

## 5. Next Steps & Blockers

Deployer ships after merge.  ST-3846 (delivery receipt) and ST-3844 (close plausibility) stay separate.  ST-3866 remains the duplicate mirror.

Merged `origin/main` at `3f4ef5e5` (ST-2582 honest approve, #4698).  Git auto-merged `PLAN.md` and `STATUS.md`.  Both headings stay.  A missing blank line between the approve entry and the ST-3846 entry was restored.  No code conflict.

```bash
npx tsc --noEmit
npx vitest run test/market-read-routes.test.ts test/congress-share.test.ts test/placement-outcome.test.ts test/placement-reconcile.test.ts test/route-proposals-approve.test.ts test/shared-package-pin-check.test.ts test/console-api-html-error.test.ts
```

`tsc --noEmit` clean.  Those seven files: 186 passed.  `npm run build` exit 0.

Hosted `verify` on `970b4909` failed in `test/event-loop-stall-hot-path.test.ts`: the unindexed scan stopped at 116ms and the indexed prune took 66ms, so `pruneMs * 4 < scanMs` was 264 < 116.  Growing the scan to 400ms then timed out the 60s test on `ab407fa4`.  The table is now a fixed 2,000,000 recent rows, scanned once.  The indexed prune must stay under 100ms and at least twice as fast as that scan.  The test timeout is 180s.  Locally the file passed in 27s.

`origin/main` moved again to `2075c857` (ST-4531) and GitHub marked the PR conflicting.  The second merge auto-merged `STATUS.md`.  The blank line before the ST-4531 heading was restored.  Main then moved to `e3ba1507` (hosted TestFlight ASC credentials).  That merge also auto-merged `STATUS.md` and `PLAN.md`.  After `verify` went green, main moved to `12702bd9` (ST-4537 nightly fundamentals/analyst push).  The only conflict was `CongressDailyShareSummary` in `src/lib/congress-share.ts`.  The resolved type keeps the stale-withhold fields and the fundamentals/analyst sent counts.

## 6. Zero-Code Findings

GROK's claim dated 2026-09-30.  `linear_claim` has no force flag.  Setting the issue to Todo removed `claimed:GROK` (`removed_labels: 1`).  CURSOR then claimed it.  Sentry org `simple-with-us` had no grouped issue for this path in 90 days.
