# Withhold stale EOD tails on the Congress.Trade wire (ST-3845)

## 1. Context & Objective

Congress.Trade treats a pushed close, and `closes[0]` on the pull, as the current price.  When every history provider misses, `fetchDailyOHLC` still returns `history-cache-eod-stale` or `imported-eod-stale` bars.  The shared `PriceSeries` schema has no provenance field, and Zod strips unknown keys before POST, so that stamp never reaches Congress.Trade.  PR #4009 stopped a stale dense import from beating a live source.  It did not stop a stale tail from being sent as current.

## 2. Changes Made

A series is fresh only when its newest close date is on or after `latestCompletedTradingSessionEtKey`.  Otherwise the nightly share omits that ticker and the S&P series, audits `congress_share_stale_price_withheld`, and counts `congress_share.stale_price_withheld`.  The pull routes return the existing empty envelope (null current price, no closes) so Congress.Trade falls back.  A stale flat-file tail still tries the live cascade before it is withheld.

- `src/lib/congress-share.ts`
- `src/lib/market-read.ts`
- `src/lib/sentry-metrics.ts`
- `test/congress-share.test.ts`
- `test/market-read-routes.test.ts`
- `docs/congress-trade-share.md`
- `STATUS.md`
- `PLAN.md`

## 3. Decisions & Trade-offs

Dropping the series, rather than adding a provenance field, is the ST-only fix.  Congress.Trade's strict row schema would strip or reject an extra field, and `currentPriceDate` is already set but not validated downstream.  Historical closes inside a stale tail are withheld with it.  Replaying them would refresh Congress.Trade's receive-time watchdog.  A flat-file miss that the live cascade can refresh is still sent.

## 4. Verification State

Commands recorded in the PR after they run.  Targeted suites: `test/congress-share.test.ts`, `test/market-read-routes.test.ts`.

## 5. Next Steps & Blockers

Deployer ships after merge.  ST-3846 (delivery receipt) and ST-3844 (close plausibility) stay separate.  ST-3866 remains the duplicate mirror.

## 6. Zero-Code Findings

GROK's claim dated 2026-09-30.  `linear_claim` has no force flag.  Setting the issue to Todo removed `claimed:GROK` (`removed_labels: 1`).  CURSOR then claimed it.  Sentry org `simple-with-us` had no grouped issue for this path in 90 days.
