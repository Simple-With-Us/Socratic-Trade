# 2026-07-10 — FMP request-quota wiring (extends the unified provider quota)

## Summary

Extended the unified per-provider request quota (`RequestQuota` in
`src/lib/provider-rate-limit.ts`, landed by PR #1310 —
`docs/rollouts/2026-07-10-unified-provider-quota.md`) to **FMP**, the last
high-volume enrichment provider that was still unmetered. Before this change,
`FmpEnrichmentProvider.enrich` fired up to **5 outbound HTTP calls per miss
symbol** — 2 unconditional (`/api/v4/insider-trading`, `/api/v4/senate-trading`)
plus up to 3 conditional (`/stable/ratios-ttm` unless `skipPe`,
`/stable/grades-consensus` unless `skipConsensus`, `/stable/price-target-consensus`
only when `wantTargets = fmpPriceTargetsEnabled() && !skipTargets`) — all under
one `fmp` circuit-breaker service, bounded only by `FMP_MAX_SYMBOLS`
(`maxSymbols()`, default `Number.POSITIVE_INFINITY`). A cold-cache scan over a
large candidate set could therefore burst past FMP Starter's account-wide
**300 requests/min** and 429.

FMP now consults the same admit/defer/refund quota path as tiingo and
twelvedata, keyed per credential so a per-user stored FMP key with its own
upstream 300/min is metered on its own lane and never gated by (nor gates) the
operator key.

## Why

- FMP is unpaced today: `resolveProviderQuota("fmp")` returned `undefined` (no
  `RATE_QUOTAS` entry), so the generic `PROVIDER_QUOTA_FMP_PER_MIN` knob was
  inert and nothing capped FMP's per-minute request volume.
- FMP's cost is **per-symbol variable** (2..5 requests depending on this
  symbol's coverage-hint skip flags), unlike tiingo (scan-uniform 2 or 3) or
  twelvedata (1 credit/symbol) — so the budget is evaluated per symbol, not once
  per scan.

## What changed

1. **`src/lib/provider-rate-limit.ts` — `RATE_QUOTAS`**: added
   `fmp: [{ maxRequests: 290, windowMs: MINUTE }]`. FMP Starter = 300/min; 290
   leaves headroom so the `fetchWithRetry` 429 backoff isn't racing the
   reservation. Deliberately **no day window** in the base (Starter has no daily
   cap) — `PROVIDER_QUOTA_FMP_PER_DAY` opts one in (e.g. 240 for the free
   250/day tier) via the existing generic env path in `resolveProviderQuota`
   (`envKeyFor("fmp") = "FMP"`). No change to `resolveProviderQuota` /
   `RequestQuota` / `admit` / `refund` — the generic env path already supports
   PER_MIN override, PER_DAY/PER_HOUR add, and `<= 0` removal.

2. **`src/lib/data-providers.ts` — `callsPerSymbol`**: widened `opts` to
   `{ dropExtra?; skipPe?; skipConsensus?; wantTargets? }` (dropExtra untouched
   for tiingo) and added
   `case "fmp": return 2 + (skipPe?0:1) + (skipConsensus?0:1) + (wantTargets?1:0)`.
   The constant 2 is insider + senate; the three `+1` terms mirror the fetch-path
   conditions one-for-one. Range 2 (skipPe && skipConsensus && !wantTargets) .. 5
   (nothing skipped && wantTargets). Exported so it can be unit-tested.

3. **`src/lib/data-providers.ts` — `FmpEnrichmentProvider.enrich`**: after
   `misses` is fully built (cache loop done) and before the CONCURRENCY fetch
   loop, inserted the admit/defer/refund block mirroring tiingo:
   - `if (misses.length === 0) return result;`
   - read `targetsEnabled = fmpPriceTargetsEnabled()` once per scan;
   - build a plan per miss symbol from the **same** `skipFlagsFor(symbol)` +
     `wantTargets = targetsEnabled && !skipTargets` the fetch path uses, with
     `cost = callsPerSymbol("fmp", { skipPe, skipConsensus, wantTargets })` — so
     reservation == dispatch, zero drift;
   - `allowed = admitProviderRequests("fmp", credKey, totalWanted)` where
     `credKey = apiKeyFingerprint(this.apiKey)`;
   - **greedy best-first prefix walk**: take whole symbols in order while they
     fit; the first that doesn't fit and all after it are deferred (preserves the
     scan's best-first priority, mirrors tiingo's slice tail);
   - `refundProviderRequests("fmp", credKey, remaining)` hands back the
     sub-symbol leftover admit over-reserved;
   - deferred symbols get `result[sym] = {}` (best-effort; NOT queried, NOT
     cached / negative-cached);
   - the CONCURRENCY loop now iterates `toQuery` (plans), reusing
     `plan.skipPe / skipConsensus / wantTargets` instead of recomputing;
   - **breaker-skip refund**: `madeCalls` = only the actually-dispatched sub-call
     slots (skipped conditionals are `Promise.resolve(undefined)`); when every
     dispatched sub-call rejected with `CircuitOpenError` (the breaker threw
     before any request left the process), `refundProviderRequests("fmp",
     credKey, plan.cost)` and skip caching.

4. **`src/lib/data-providers.ts` — `FmpEnrichmentProvider.getJson`**: added
   `retries: 0` to the `fetchWithRetry` options. Each of the up-to-5 endpoints
   reserves exactly one request; a built-in 429 retry would emit a second
   UNCOUNTED call and blow past the 290/min reservation (headroom is only 10).
   Same rationale as tiingo/twelvedata's `getJson`.

Cache discipline unchanged for fetched symbols; deferred symbols spend nothing
and are covered by the cascade + shared 6h fundamentals cache across scans, so
coverage accretes (same as tiingo/twelvedata deferral). Conditional-call skips
are netted at RESERVATION time (a `skipPe` symbol reserves 4, never 5), which is
strictly equivalent to a reserve-then-refund round-trip while guaranteeing
reservation == dispatch.

`FMP_MAX_SYMBOLS` is unchanged: `maxSymbols()` still slices the candidate list at
the top of `enrich` (before the quota), so it remains the separate per-scan
symbol throttle; the quota is the per-minute request budget beneath it.

## Files

- `src/lib/provider-rate-limit.ts` — `RATE_QUOTAS.fmp` entry.
- `src/lib/data-providers.ts` — `callsPerSymbol` (widened opts + fmp case,
  exported); `apiKeyFingerprint` exported; `FmpEnrichmentProvider.enrich`
  (admit/defer/refund + breaker-skip); `FmpEnrichmentProvider.getJson`
  (`retries: 0`).
- `test/provider-rate-limit.test.ts` — `resolveProviderQuota("fmp")` default +
  PER_MIN/PER_DAY overrides; `RequestQuota` admit/refund/reopen + PER_DAY cap for
  fmp; new `PROVIDER_QUOTA_FMP_*` env-cleanup keys.
- `test/data-providers.test.ts` — `callsPerSymbol("fmp")` across skip combos
  (2..5); FMP enrich quota defer + partial-remainder refund; breaker-skip refund
  + no-cache; cache-hit-no-spend; per-credential isolation; `retries: 0`.
- `.env.example` — documented `PROVIDER_QUOTA_FMP_PER_MIN` (default 290) and
  `PROVIDER_QUOTA_FMP_PER_DAY` (unset = off; 240 on free tier) near the FMP block.
- `docs/market-data-provider-pricing.md` — added FMP to the "Where the dials
  live" knob list, the HARD_DEFAULTS gap note, and the upgrade cheat-sheet row.
- `STATUS.md`, `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md`.

## Verification

Run under Node 24 (`/opt/homebrew/opt/node@24/bin` on PATH; the shared
`node_modules` had drifted to a Node 26 ABI build, so a worktree-local
`npm install` under Node 24 was done first):

- `npx tsc --noEmit` — clean (pre-existing unrelated `test/alternative-data.test.ts`
  mockFetcher error only, per AGENTS.md).
- `npm run lint` — 0 errors (376 grandfathered warnings).
- `npm test` — 315 files, **3412/3412** passed.
- `npm run build` — Compiled successfully.

Focused: `npx vitest run test/provider-rate-limit.test.ts test/data-providers.test.ts`
— 154/154.

## Follow-ups / risks

- **Overshoot (>300/min → 429)**: mitigated because cost mirrors the fetch
  conditions exactly (same `skipFlagsFor` + `wantTargets` formula) and
  `retries: 0` removes the uncounted 429 retry. Headroom is only 10, so both
  matter — keep `callsPerSymbol`'s fmp terms one-to-one with the
  `Promise.allSettled` conditions if either side changes.
- **Multi-instance**: `RequestQuota` is per-process/in-memory (same as
  tiingo/twelvedata), so N app instances each hold a 290 lane → aggregate can
  exceed 300 across instances. Accepted/consistent with existing providers; not
  solved here.
- **Warm-cache steady state**: the quota spends only on cache misses, so it
  rarely binds once the 6h fundamentals cache is warm; a cold cache or large
  fresh candidate set bursts up to 290/min then defers the tail best-effort
  (intended). A low `FMP_MAX_SYMBOLS` makes the quota rarely bind.
