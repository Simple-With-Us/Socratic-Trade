# Data cascade reliability (rate limits, VIX, Nasdaq universe)

## Context & Objective

Harden the market-data cascade against rate limits and slow Nasdaq screener fetches that pushed freshness scans toward ~8 minutes.  Pace every RapidAPI host and the Nasdaq screener, honor `Retry-After` on 429s, TTL-cache successful enrichment fields, reorder VIX sources, and serve a stale Nasdaq universe with background refresh plus SEC/Nasdaq Trader fallback.

## Changes Made

- Provider pacing: `resolveProviderLimiterKey` for `*.rapidapi.com` hosts; hard defaults for `nasdaq-delayed-screener`, `congress-nasdaq-screener`, and `rapidapi-host`; screener fetch wrapped in `withProviderLimit`.
- `fetchWithRetry`: jittered backoff respects `Retry-After`.  The lane breaker opens only after retries are exhausted, and only for a positive `Retry-After`.  A 429 that still has a retry, or that has no `Retry-After`, does not open the lane.
- `provider-field-cache.ts`: write on enrichment first-win; read stale values per symbol+field when the cascade misses.  Cap 50k entries.  Symbol+field reads are O(1).
- VIX: `VIX_History.csv` primary, FRED `VIXCLS` when keyed, then Cboe delayed JSON, then Yahoo (`macro.ts`, source-capability matrix, health backup lanes).
- Nasdaq screener: stale-while-revalidate via `screenerLastGood` + background refresh.  On a cold failure, `fetchFallbackUniverseRows` lists the SEC/Nasdaq Trader directory (`nasdaq-universe-fallback.ts`, `market.ts`).  One failed directory source does not drop the others.  Those rows have no price, so they are not cached and they are not returned as a quote universe.  The screener error stays, with either the directory's own failure or a count of unpriced symbols that were left out of the cache.  Explicit symbols still recover from the last scan, then Yahoo.
- Freshness lane deadline lowered to 6 minutes (`FRESHNESS_SCAN_DEADLINE_MS`).

**Files**

- `src/lib/provider-rate-limit.ts`
- `src/lib/provider-field-cache.ts`
- `src/lib/network-errors.ts`
- `src/lib/api-circuit-breaker.ts`
- `src/lib/data-providers.ts`
- `src/lib/nasdaq-screener-fetch.ts`
- `src/lib/nasdaq-universe-fallback.ts`
- `src/lib/market.ts`
- `src/lib/macro.ts`
- `src/lib/market-scan-freshness.ts`
- `src/lib/health-lane-reprobe.ts`
- `src/lib/source-capability-matrix.ts`
- `test/*.test.ts` (new/updated)

## Decisions & Trade-offs

- Stale screener rows return immediately when TTL expires but last-good exists; live refresh runs in the background (best-effort, no caller await).
- The keyless directory is a failure annotation, not quote coverage.  `parseNasdaqTraderPipe` emits symbol and name only, and the cold-failure path is the only time it runs, so there is no prior price to copy.  Returning or caching those rows would either look like an empty scan or block Nasdaq until the close.
- FRED VIXCLS stays keyed-only in the live cascade; unkeyed installs skip straight to Cboe JSON.
- Field cache is in-memory (6h TTL), not durable — matches enrichment cache posture.

## Verification State

```bash
npm run lint -> ok (0 errors, 866 warnings)
npx tsc --noEmit -> ok
npm test -- test/nasdaq-screener-fallback-cache.test.ts test/nasdaq-universe-fallback.test.ts test/scan-empty-screener.test.ts test/provider-rate-limit.test.ts test/transient-network-resilience.test.ts -> 110 passed
```

Full `npm test` on this machine: 9320 passed, 51 skipped, 2 failed.  Both are outside this diff.  `test/egress-guard.test.ts` cannot resolve discord.com in this sandbox.  `test/data-catalog-completeness.test.ts` scores `peRatio` from the local default database (it expects an empty store).  Hosted `verify` on `4fc19a96` was green.  `npm run build` was not re-run here.

## Next Steps & Blockers

- Monitor prod freshness scan duration after deploy; tune `FRESHNESS_SCAN_DEADLINE_MS` if 6m is too tight on heavy enrichment days.
- None blocking merge.

## Zero-Code Findings

- ~8m freshness runs align with trading-day full enrichment under the prior 10m outer deadline plus Nasdaq screener blocking; SWR + 6m cap targets that wedge.
