# Keyless options enrichment (Cboe / Alpaca / Tradier)

## Context & Objective

`nearTheMoneyIv` and `putCallRatio` were only filled by opt-in Robinhood MCP enrichment, so shared and background market scans left those cells empty.  Wire keyless Cboe delayed options JSON as the primary source, Alpaca indicative snapshots and Tradier chains as fallbacks, using the same `deriveOptionMetrics` math as `robinhood-options.ts`.

## Changes Made

- Added `src/lib/keyless-options-enrichment.ts` with `CboeOptionsEnrichmentProvider`, `AlpacaOptionsEnrichmentProvider`, and `TradierOptionsEnrichmentProvider` (per-symbol cache, paced sequential fetches).
- Registered providers in `getEnrichmentProvider()` when `KEYLESS_OPTIONS_ENRICHMENT_ENABLED` is on (default ON).
- Updated `src/lib/source-capability-matrix.ts`, `src/lib/enrichment-coverage.ts` (`COVERAGE_OPTIONS_METRICS_FIELDS`), and `src/lib/data-catalog.ts`.
- Tests: `test/keyless-options-enrichment.test.ts`, `test/keyless-options-vendor-fetch.test.ts`, `test/enrichment-coverage.test.ts`, `test/source-capability-matrix.test.ts`.

## Decisions & Trade-offs

- Three cascade providers (not one internal fallback) so per-field `sources` attribution matches the capability matrix.
- Alpaca/Tradier lanes register only when market-data / Tradier credentials resolve (same pattern as snapshot + history tiers).
- Cboe stays `costTier: "free"` (Wave A).  Alpaca and Tradier are `costTier: "paid"` so they run in Wave B only for symbols still missing `nearTheMoneyIv` or `putCallRatio`.  Those fields stay out of `WAVE_B_GAP_FIELDS` so a missing IV does not wake Finnhub.
- Vendor JSON is parsed with Zod `safeParse` (Cboe, Alpaca snapshots, Alpaca IEX underlying snapshot, Tradier expirations, chains, and quotes).  A bad payload records a failed call and returns null.
- Alpaca reads root `impliedVolatility` and `dailyBar.v`.  Open interest is not on the snapshot payload; put/call falls back to volume.  Underlying price comes from the payload when present, otherwise an IEX stock snapshot (`feed=iex`) or a Tradier quote.  A Tradier `underlying` ticker string is not treated as a price.
- Empty metric results are negative-cached for `min(TTL, 5 minutes)`.  Unexpected throws are not cached.
- Cboe fetch uses `fetch` with redirect follow (CDN → `cdn-api.cboe.com`); Alpaca/Tradier use `politeFetch` to avoid a `data-providers` import cycle.

## Verification State

- npm run lint -> ok (0 errors)
- npx tsc --noEmit -> ok
- npm test -> 2 failed, 9315 passed, 51 skipped.  Failures are outside this diff: sandbox DNS for discord.com in `test/egress-guard.test.ts`, and `pruneTaskJournal` at 238ms against a 100ms budget in `test/event-loop-stall-hot-path.test.ts`.  Targeted options and coverage tests (43) passed.
- npm run build -> ok
(2026-10-14, cloud VM)

## Next Steps & Blockers

- None for merge; production will pick up on deploy after `main` merge (docs-only paths excluded from Coolify `watch_paths` — runtime files are in the diff).

## Zero-Code Findings

- Live Cboe options JSON for `AAPL` includes `data.current_price` and per-contract `iv` / `open_interest` / OCC `option` symbols; many deep ITM rows carry `iv: 0`, so ATM filtering in `deriveOptionMetrics` remains important.
