# 2026-11-23 — Wave 2C Alpha Factor Scoring Overhaul, Nightly OHLC Rotation, RTH Gap Stop Confirmation, Macro Calendar & Sell-to-Fund Ranking (ST-4666)

## 1. Context & Objective

Resolve six quantitative alpha-factor, execution-protection, macro-awareness, and liquidation-ranking biases identified in the Wave 2 strategy audit (`ST-4666`).  Prior to this change, Stage 1/2 candidate scoring in `<install-path>/src/lib/market.ts` ranked raw share volume instead of dollar volume, chased 1-day intraday spikes, defaulted missing valuations to `65`/`70` for mega-caps (`marketCap >= 5B`), scored 1-day intraday change as volatility, weighted undated headline keywords at `0.6`, used a flat `45` vs `80` diversification score, and only refreshed `setTechnicalWatchlist` on yesterday's top candidates; synthetic stops stalled 3 ticks (~3 minutes) on genuine `>10%` RTH gap-downs; `refreshEconomicCalendarIfStale` had no default FOMC/CPI/NFP calendar provider; `planFundingSells` liquidated by raw dollar loss; `atrStopPct` allowed up to a `50%` stop distance; and the ADV cap in `applyDeterministicSizing` used same-day `5%` volume instead of `1%` trailing 20d dollar ADV.

## 2. Changes Made

- **Stage 1 & Stage 2 Factor Scoring Overhaul & Nightly OHLC Rotation (`<install-path>/src/lib/market.ts`)**:
  - **Liquidity**: Updated `liquidityScore` to compute dollar volume `log10(price * volumeOrAvgVol20d)` (preferring `avgVolume20d` / `averageVolume20d` / `avgVol20d` when present, falling back to `volume`) mapped onto `[0, 100]` over `[$100k, $1B]`.
  - **Momentum**: Added `multiHorizonTrendScore` combining `20d`, `60d`, and `126d` trend returns minus a `5d` short-term reversal term, falling back gracefully to 52-week range position, bar-based `technicalScore`, and damped intraday momentum when multi-horizon history is absent.
  - **Value & Quality**: Replaced mega-cap size fallbacks (`marketCap >= 5B ? 65` in `valueScore` and `marketCap >= 10B && volume >= 1M ? 70` in `qualityScore`) with a neutral `50` baseline when valuation/fundamentals are missing, and added scoring for `pbRatio`, `earnYld` (`eps / price`), `targetMean` upside, `returnOnEquity`, `grossProfitMargin`, and `revenueGrowth`.
  - **Volatility**: Updated `volatilityScore` to score `20d`/`60d` annualized realized volatility (`realizedVol20d`, `realizedVol60d`, `realizedVolPct`) and daily `atrPct` / `atr14` (with a 52-week range fallback) before applying the `beta` adjustment, rather than `100 - |intradayChangePct| * 12`.
  - **Sentiment**: Added `sentimentScore` downweighting undated headline keyword scores from `0.6` to `0.2` relative to neutral (`50`) or analyst consensus while keeping dated sentiment observations at `0.6`.
  - **Diversification**: Added `diversificationScore` and `derivePortfolioSectorWeights` so `scoreFactors` and `rankMarketQuotes` penalize candidates in already-concentrated portfolio sectors and reward unrepresented sectors when `portfolioSectors` are provided.
  - **Nightly OHLC Rotation**: Added `buildRotatingTechnicalWatchlist` and wired it at `setTechnicalWatchlist` so ~35% of watchlist slots rotate through broader ranked-universe symbols across scans.
- **Immediate RTH Two-Sided Quote Gap Confirmation (`<install-path>/src/lib/synthetic-stops.ts`)**:
  - When an out-of-band print (`> BAD_TICK_PCT`) arrives during regular trading hours (`currSession === "regular"`), `runSyntheticStopMonitor` checks whether the broker quote carries a real (non-synthetic) two-sided spread with `bid > 0 && ask > 0 && (ask - bid) / mid < 0.03`.  Confirmed RTH gaps evaluate and fire immediately on tick 1 without waiting 3 ticks.
- **FOMC/CPI/NFP Macro Calendar Seed Provider (`<install-path>/src/lib/economic-calendar.ts`)**:
  - Implemented `fetchMacroSeedCalendar(from, to)` covering published Federal Reserve FOMC rate decision dates (`18:00:00` UTC), BLS CPI release dates (`12:30:00` UTC), and BLS Nonfarm Payrolls first-Friday releases (`12:30:00` UTC), and wired it as the default `fetchCalendar` parameter in `refreshEconomicCalendarIfStale`.
- **Forward-Score & Tax/Wash-Sale Liquidation Ranking (`<install-path>/src/lib/sell-to-fund.ts`)**:
  - Updated `planFundingSells` with `computeLiquidationPriority` to rank holdings by lowest forward conviction/factor score plus tax/wash-sale efficiency (rewarding clean tax-loss harvesting, penalizing lots with active wash-sale risk, and differentiating short-term vs long-term capital-gains tax drag) and added a `Math.ceil` overshoot guard when a single high-priced share would excessively overshoot the remaining shortfall.
- **Tightened ATR Stop Clamp & Trailing 20d Dollar ADV Cap (`<install-path>/src/lib/indicators.ts`, `<install-path>/src/lib/strategy-risk.ts`)**:
  - Tightened `atrStopPct` default `capPct` in `<install-path>/src/lib/indicators.ts` from `50` (`50%`) to `25` (`25%`).
  - Updated the ADV cap in `applyDeterministicSizing` (`<install-path>/src/lib/strategy-risk.ts`) to use `1%` (`Math.min(policy.maxOrderPctOfAdv, 1)%`) of trailing 20d dollar ADV (`price * avgVolume20d`) when 20d average volume is present on the scan candidate, falling back cleanly to `policy.maxOrderPctOfAdv`% of same-day dollar volume when unavailable.

### Exact Touched Files

- `<install-path>/src/lib/market.ts`
- `<install-path>/src/lib/synthetic-stops.ts`
- `<install-path>/src/lib/economic-calendar.ts`
- `<install-path>/src/lib/sell-to-fund.ts`
- `<install-path>/src/lib/indicators.ts`
- `<install-path>/src/lib/strategy-risk.ts`
- `<install-path>/test/market.test.ts`
- `<install-path>/test/synthetic-stops.test.ts`
- `<install-path>/test/economic-calendar.test.ts`
- `<install-path>/test/sell-to-fund.test.ts`
- `<install-path>/test/atr-indicators.test.ts`
- `<install-path>/test/antigravity-cheap-wins.test.ts`
- `<install-path>/STATUS.md`
- `<install-path>/docs/rollouts/2026-11-23-wave2-alpha-factors.md`

## 3. Decisions & Trade-offs

- **Backwards-compatible factor scoring & liquidation inputs**: `scoreFactors` accepts an optional `ScoreFactorsContext` (`portfolioSectors`) and reads optional multi-horizon/realized-vol fields off `MarketQuote`, while `planFundingSells` defaults missing forward scores to neutral `50` so existing callers without explicit forward scores still prefer tax-efficient loss harvesting first.
- **Keyless deterministic macro calendar seed**: `fetchMacroSeedCalendar` requires zero external API keys or network calls, ensuring `getUpcomingEconomicEventsForPrompt` reliably populates upcoming FOMC, CPI, and NFP windows while remaining overridable by any injected `fetchCalendar` function.
- **Real two-sided quote requirement for immediate RTH gap exits**: Synthetic or one-sided quotes, as well as wide (`>= 3%`) open auction spreads, still require the 3-tick confirmation loop so a single stale/wide print cannot premature-stop a position.

## 4. Verification State

- `npm run lint` — passed (`0` errors)
- `npx tsc --noEmit` — passed (`0` errors)
- `npx vitest run test/market.test.ts test/market-preselection.test.ts test/web-sources-technical.test.ts test/synthetic-stops.test.ts test/economic-calendar.test.ts test/sell-to-fund.test.ts test/atr-indicators.test.ts test/antigravity-cheap-wins.test.ts test/vol-targeting-sizing.test.ts` — passed (`9/9` test files)
- `npm run build` — passed (Next.js production build + CSP static hash stamp)

## 5. Next Steps & Blockers

- Push `ag/kk-wave2-alpha-factors`, open PR for `ST-4666`, and merge after CI `verify` and review complete.
