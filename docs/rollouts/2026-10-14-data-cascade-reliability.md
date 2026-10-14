# Data cascade reliability (rate limits, VIX, Nasdaq universe)

## Context & Objective

Harden the market-data cascade against rate limits and slow Nasdaq screener fetches that pushed freshness scans toward ~8 minutes.  Pace every RapidAPI host and the Nasdaq screener, honor `Retry-After` on 429s, TTL-cache successful enrichment fields, reorder VIX sources, and serve a stale Nasdaq universe with background refresh plus SEC/Nasdaq Trader fallback.

## Changes Made

- Provider pacing: `resolveProviderLimiterKey` for `*.rapidapi.com` hosts; hard defaults for `nasdaq-delayed-screener`, `congress-nasdaq-screener`, and `rapidapi-host`; screener fetch wrapped in `withProviderLimit`.
- `fetchWithRetry`: jittered backoff respects `Retry-After`.  The lane breaker opens only after retries are exhausted, and only for a positive `Retry-After`.  A 429 that still has a retry, or that has no `Retry-After`, does not open the lane.
- `provider-field-cache.ts`: write on enrichment first-win; read stale values per symbol+field when the cascade misses.  Cap 50k entries.  Symbol+field reads are O(1).
- VIX: `VIX_History.csv` primary, FRED `VIXCLS` when keyed, then Cboe delayed JSON, then Yahoo (`macro.ts`, source-capability matrix, health backup lanes).
- Nasdaq screener: stale-while-revalidate via `screenerLastGood` + background refresh; `fetchFallbackUniverseRows` on hard failure (`nasdaq-universe-fallback.ts`, `market.ts`).  One failed directory source does not drop the others.  Price-less directory rows are not cached.  A fallback failure keeps the original screener error.
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
- FRED VIXCLS stays keyed-only in the live cascade; unkeyed installs skip straight to Cboe JSON.
- Field cache is in-memory (6h TTL), not durable — matches enrichment cache posture.

## Verification State

```bash
npm run lint -> ok (0 errors, 866 warnings)
npx tsc --noEmit -> ok
npm test -- test/provider-field-cache.test.ts test/nasdaq-universe-fallback.test.ts test/network-retry-after.test.ts test/macro-live-vix.test.ts test/provider-rate-limit.test.ts test/health-lane-reprobe.test.ts test/market-scan-freshness.test.ts -> ok
npm run build -> ok
```

Full `npm test` on this machine: 9313 passed, 51 skipped, 1 failed.  The failure is `test/egress-guard.test.ts` resolving discord.com with real DNS in this sandbox.  It is outside this diff.  Hosted CI resolved that host on the previous run.

## Next Steps & Blockers

- Monitor prod freshness scan duration after deploy; tune `FRESHNESS_SCAN_DEADLINE_MS` if 6m is too tight on heavy enrichment days.
- None blocking merge.

## Zero-Code Findings

- ~8m freshness runs align with trading-day full enrichment under the prior 10m outer deadline plus Nasdaq screener blocking; SWR + 6m cap targets that wedge.
