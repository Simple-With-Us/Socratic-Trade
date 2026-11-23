# 2026-11-22 — Wave 1 Signals, Intraday Live VIX & Paper Cost Fixes (ST-4647)

## 1. Context & Objective

Close four high-leverage signal, volatility, and transaction-cost bugs identified in the November 2026 strategy and signal audit (`ST-4647`).  Prior to this change, `fetchKeylessVix` served yesterday's EOD `VIX_History.csv` close ahead of intraday Cboe/Yahoo quotes, `positioningScore` ignored `congressCompositeScore` in favor of raw `senateTrades` counts, Polymarket classified `"no Fed rate cuts"` as `"fed_cut"` (`bullish` on Yes), and paper fills charged the full 20 bps round-trip floor on both entry and exit legs (40 bps round-trip).

## 2. Changes Made

- **Intraday Live VIX Cascade & Regime Caller Wiring (`src/lib/macro.ts`, `src/lib/proposal-revalidation.ts`, `src/lib/strategy.ts`)**:
  - Reordered `fetchKeylessVix()` to try intraday sources first: (1) `fetchVixFromCboe()` (`cdn.cboe.com/.../_VIX.json` `current_price`), (2) `fetchVixFromYahoo()` (updated to read `chart.result[0].meta.regularMarketPrice` before falling back to `indicators.quote[0].close`), (3) `fetchVixFromCboeHistoryCsv()` (EOD close fallback), and (4) `fetchVixFromFredVixcls()` (EOD close fallback).
  - Upgraded regime-classification callers in `src/lib/proposal-revalidation.ts` and `src/lib/strategy.ts` (learned-context regime filter, episodic experience sketch, alternative-data analysis node, and candidate evidence digest) to use `fetchMacroDataWithLiveVix`.
- **Congress Composite Score in `positioningScore` (`src/lib/market.ts`)**:
  - Updated `positioningScore(quote)` to apply a bounded delta in `[-18, +18]` (`Math.round(Math.max(-18, Math.min(18, signedScore * 0.18)))`) when a non-neutral `congressCompositeScore` / `congressCompositeSignedScore` with `confidence > 0` is present on the quote, falling back to the raw `senateTrades` count only when the composite score is absent.
- **Polymarket `"no rate cuts"` / `"fed_hold"` Classification (`src/lib/polymarket-signals.ts`, `src/lib/polymarket-provider.ts`)**:
  - Added `"fed_hold"` to `PolymarketMarketKind`, matched `/\bno (fed )?rate cuts?|\bfed\b.*\b(?:hold|pause|keep rates)/i` before `"fed_cut"` in `classifyMarketKind()`, mapped `yesImpliesForKind("fed_hold")` to `"bearish"`, and preserved specific non-`"other"` question kinds in `fetchPolymarketMacroContext()`.
- **Paper Execution Cost Per-Leg Base Floor (`src/lib/execution-cost.ts`)**:
  - Changed `PAPER_DEFAULT_BASE_SLIPPAGE_BPS` from `OOS_ROUND_TRIP_COST_BPS` (`20`) to `OOS_ROUND_TRIP_COST_BPS / 2` (`10` bps per fill leg = `20` bps round-trip across entry + exit).

### Exact Touched Files

- `src/lib/macro.ts`
- `src/lib/proposal-revalidation.ts`
- `src/lib/strategy.ts`
- `src/lib/market.ts`
- `src/lib/polymarket-signals.ts`
- `src/lib/polymarket-provider.ts`
- `src/lib/execution-cost.ts`
- `test/macro-live-vix.test.ts`
- `test/market.test.ts`
- `test/polymarket-signals.test.ts`
- `test/execution-cost.test.ts`
- `test/learning-loop-autotuning-db.test.ts`
- `test/performance.test.ts`
- `STATUS.md`
- `docs/rollouts/2026-11-22-wave1-signals-vix-cost-fixes.md`

## 3. Decisions & Trade-offs

- **Post-placement macro fetch in `src/lib/strategy.ts`**: The post-placement evidence digest awaits `Promise.allSettled([fetchMacroData(userId), fetchLiveVix()])`, preserving the 10-minute TTL cache and test mock compatibility.  If `baseMacroSettled` rejects, it explicitly throws an error before building evidence.
- **Concurrent `fetchKeylessVix` probing**: `fetchKeylessVix` executes all keyless VIX sources concurrently via `Promise.all([fetchVixFromCboe(), fetchVixFromYahoo(), fetchVixFromCboeHistoryCsv(), fetchVixFromFredVixcls()])` to avoid sequentially stacking 4x network timeouts before EOD fallback, while returning in strict priority order (`fromCboe ?? fromYahoo ?? fromHistory ?? fromFred`).
- **Zod validation on Yahoo VIX**: `fetchVixFromYahoo` parses external chart payloads using `VixYahooSchema.safeParse` with nullable quote elements, ensuring null entries in `indicators.quote` do not fail validation or discard valid `meta.regularMarketPrice`.
- **Congress confidence & direction reconciliation**: `congressPositioningDelta` requires finite `confidence > 0` and reconciles `rawSigned` sign against `effectiveDirection` before scaling.  When given an object payload without `signedScore`, it falls back to `{ score, direction, confidence }` with direction-sign reconciliation.
- **Curated macro Polymarket kinds**: `fetchPolymarketMacroContext` keeps `spec.kind` authoritative so matched search queries cannot hijack curated macro theme tilts.
- **Defensive `congressPositioningDelta` extraction**: Supports both the flat `MarketQuote` properties (`congressCompositeSignedScore`, `congressCompositeScore`, `congressCompositeDirection`, `congressCompositeConfidence`) populated by `scanMarket` and object-shaped `congressCompositeScore` payloads in unit tests.

## 4. Verification State

- `npm run lint` — passed (`0 errors, 894 warnings`)
- `npx tsc --noEmit` — passed (`0` type errors)
- `npx vitest run test/macro-live-vix.test.ts test/market.test.ts test/polymarket-signals.test.ts test/execution-cost.test.ts test/strategy-lock-loss-integration.test.ts` — passed (`5/5` files, `86/86` tests)
- `npm run build` — passed (Next.js 16.4.6 production webpack build + `stamp-csp-static-hashes.mjs`)

## 5. Next Steps & Blockers

- Open PR from `ag/wave1-signals-vix-cost` and merge after CI `verify` and review complete.
