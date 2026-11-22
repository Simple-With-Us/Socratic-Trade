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

- **Post-placement macro fetch in `src/lib/strategy.ts`**: The post-placement evidence digest awaits both `fetchMacroData(userId)` and `fetchMacroDataWithLiveVix(userId)` via `Promise.all`, preferring the live-VIX overlay when its `vix` is non-empty while preserving the `fetchMacroData` hook that `test/strategy-lock-loss-integration.test.ts` uses to simulate post-placement lease loss.
- **Defensive `congressPositioningDelta` extraction**: Supports both the flat `MarketQuote` properties (`congressCompositeSignedScore`, `congressCompositeScore`, `congressCompositeDirection`, `congressCompositeConfidence`) populated by `scanMarket` and object-shaped `congressCompositeScore` payloads in unit tests.

## 4. Verification State

- `npm run lint` — passed (`0 errors, 893 warnings`)
- `npx tsc --noEmit` — passed (`0` type errors)
- `npx vitest run test/macro-live-vix.test.ts test/macro.test.ts test/cache-provenance.test.ts test/proposal-revalidation.test.ts test/strategy-macro-prompt-wiring.test.ts test/strategy-lock-loss-integration.test.ts test/market.test.ts test/polymarket-signals.test.ts test/polymarket-provider.test.ts test/execution-cost.test.ts test/learning-loop-autotuning-db.test.ts test/performance.test.ts` — passed (`12/12` files, `210/210` tests)
- `npm test` — `946` test files passed (`10,878` tests passed, `42` skipped; only pre-existing `test/cpuprofile-summary.test.ts` child-process `.ts` import under bare Node v22.22.1 failed)
- `npm run build` — passed (Next.js 16.4.6 production webpack build + `stamp-csp-static-hashes.mjs`)

## 5. Next Steps & Blockers

- Open PR from `ag/wave1-signals-vix-cost` and merge after CI `verify` and review complete.
