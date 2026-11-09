# 2026-06-25 — Universe floor (penny / illiquid exclusion) — Phase 1

Branch `agent/claude-settings-overhaul`. First phase of the program in
`docs/settings-and-universe-overhaul-plan.md`.

## Summary
Adds a tunable universe-eligibility floor that excludes penny / illiquid micro-cap names from the
**scanned candidate set**, so the LLM and proposals never consider them. Default-on with sensible
thresholds; a no-op for the default S&P-500 universe (every member clears it) — it bites only when the
universe is broadened to other indexes / the wider screener.

## Why
Owner asked to exclude penny stocks and to broaden the universe to other indexes above a market-cap floor.
Penny/illiquid names carry wide spreads, manipulation risk, poor data, and unrealistic fills — unsafe for
the strategy. This floor is the eligibility gate that also unblocks the Phase-4 backfill expansion.

## What changed
- **`src/lib/types.ts`** — new `UniverseFloor` interface (`minPrice`, `minMarketCapUsd`, `minDollarVolume`);
  `TradingPolicy.universeFloor?`; `MarketDataProviderOptions.universeFloor?`.
- **`src/lib/defaults.ts`** — `DEFAULT_POLICY.universeFloor = { minPrice: 5, minMarketCapUsd: 100_000_000,
  minDollarVolume: 1_000_000 }`. Inherited by existing stored policies via `mergePolicy` (spreads defaults).
- **`src/lib/market.ts`** — pure `passesUniverseFloor` / `universeFloorActive` / `applyUniverseFloor`;
  applied in `nasdaqDelayedProvider.scan` **before ranking**, exempting `allowed` (explicit `additionalSymbols`
  + held positions). Threaded `universeFloor` through `scanMarket` → provider options.
- **Call sites** — `strategy.ts` (run + approval scans) and `app/api/scan/route.ts` pass `policy.universeFloor`.

## Design choices
- **Exemptions:** explicitly-listed symbols and held positions are NEVER filtered (deliberate user intent /
  never trap an exit); exits are never affected (this is a candidate-eligibility filter, opening-only by nature).
- **Missing data never excludes:** market-cap and dollar-volume bounds apply only when that datum is known;
  the price floor (always present) is the reliable penny gate. Negative/zero bounds are ignored.
- Default thresholds are deliberately conservative ($5 / $100M / $1M $-vol) to exclude pennies + micro junk
  without dropping legitimate small-caps; fully tunable (settings UI in Phase 3).

## Verification
- `npx tsc --noEmit` — clean.
- `npx vitest run test/universe-floor.test.ts test/market.test.ts` — 24 passed.
- Full `npm test` + `npm run build` via `scripts/land.sh` before PR.

## Follow-ups
- Phase 2: take-profit partial trim (with re-trigger ratchet).
- Phase 3: settings overhaul — surface `universeFloor` (+ all hidden fields) and the stop/broker labels.
- Phase 4: apply the same floor to the share/backfill universe + Massive flat files for scale.
