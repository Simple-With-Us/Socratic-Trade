import type { MarketQuote, MarketQuoteSummary } from "./types";

/**
 * Backend-computed financial metrics derived purely from fields we already fetch
 * (price/volume/eps/peRatio/pbRatio/dividendYield/epsGrowth/bid/ask). None of these
 * are returned directly by our data providers, but all are standard, decision-relevant
 * ratios — so we compute them deterministically here and hand them to the LLM rather
 * than (a) making it do error-prone arithmetic on large numbers or unit-mismatched
 * fields, or (b) paying for another API. Every value is `undefined` when its inputs are
 * missing or the ratio is not meaningful, so it simply drops out of the JSON payload.
 *
 * UNIT CONTRACT (verified against data-providers.ts + the dashboard formatters):
 *   - dividendYield, fcfYield  → already a PERCENT number (e.g. 2.05 == 2.05%)
 *   - epsGrowth                → a FRACTION (e.g. 0.56 == 56% YoY; UI multiplies by 100)
 *   - eps, price               → dollars; peRatio, pbRatio → plain ratios
 * Keep this in sync if any provider changes a field's units.
 */
export interface DerivedMetrics {
  /** PEG = P/E ÷ (annual EPS growth %). <1 cheap-for-growth, >2 expensive. */
  peg?: number;
  /** Earnings yield % = EPS ÷ price (the inverse of P/E). Robust when P/E is n/a (eps ≤ 0). */
  earnYld?: number;
  /** Return on equity %. Provider-reported (ratios-ttm) when available; else EPS ÷ BVPS, where BVPS = price ÷ P/B. Quality/efficiency. */
  roe?: number;
  /** Dividend payout ratio % = dividends per share ÷ EPS. >100 flags an unsustainable dividend. */
  payout?: number;
  /** Daily traded notional in $millions = price × volume ÷ 1e6. Liquidity gauge for sizing/slippage. */
  dollarVolM?: number;
  /** Bid-ask spread in basis points = (ask − bid) ÷ mid × 1e4. Execution cost / micro-liquidity. */
  spreadBps?: number;
  /** Benjamin Graham's intrinsic-value estimate = √(22.5 × EPS × book value per share). Defensive fair value. */
  grahamNumber?: number;
  /** Margin of safety % = (Graham number − price) ÷ price. Positive = trading below intrinsic value. */
  marginOfSafety?: number;
  /** % from the 52-week high = (price − high) ÷ high. Negative = below the high (pullback/drawdown depth). */
  pctFromHigh?: number;
  /** Reward:risk to the 52-week band = (high − price) ÷ (price − low). >1 = more upside room than downside cushion. */
  rr52w?: number;
}

const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const isFinitePositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Compute the derived-metric bundle for a quote. Pure and total — never throws, returns
 * only the fields whose inputs are present and sensible.
 */
export function deriveMetrics(quote: Pick<
  MarketQuote | MarketQuoteSummary,
  "price" | "eps" | "peRatio" | "pbRatio" | "dividendYield" | "fiftyTwoWeekHigh" | "fiftyTwoWeekLow"
> & { volume?: number; epsGrowth?: number; bid?: number; ask?: number; returnOnEquity?: number }): DerivedMetrics {
  const { price, eps, peRatio, pbRatio, dividendYield, volume, epsGrowth, bid, ask, fiftyTwoWeekHigh, fiftyTwoWeekLow, returnOnEquity } = quote;
  const metrics: DerivedMetrics = {};

  // PEG — only meaningful with positive earnings (P/E > 0) and real growth (≥1% YoY),
  // otherwise a near-zero denominator produces an explosive, useless number.
  if (isFinitePositive(peRatio) && isFiniteNumber(epsGrowth) && epsGrowth * 100 >= 1) {
    metrics.peg = round(peRatio / (epsGrowth * 100), 2);
  }

  // Earnings yield — sign-preserving (a negative value is a real signal of losses).
  if (isFinitePositive(price) && isFiniteNumber(eps)) {
    metrics.earnYld = round((eps / price) * 100, 2);
  }

  // ROE — prefer the provider-reported value (FMP ratios-ttm, already a PERCENT number) over the
  // structural EPS/BVPS approximation; the eps×pb/price identity remains the fallback when no
  // provider reported it. Sign-preserving either way.
  if (isFiniteNumber(returnOnEquity)) {
    metrics.roe = round(returnOnEquity, 1);
  } else if (isFinitePositive(price) && isFinitePositive(pbRatio) && isFiniteNumber(eps)) {
    metrics.roe = round(((eps * pbRatio) / price) * 100, 1);
  }

  // Payout ratio — only when the company both earns (eps > 0) and pays a dividend.
  if (isFinitePositive(eps) && isFinitePositive(dividendYield) && isFinitePositive(price)) {
    metrics.payout = round((dividendYield * price) / eps, 1);
  }

  // Dollar volume in $M — the standard liquidity yardstick (raw share volume ignores price).
  if (isFinitePositive(price) && isFinitePositive(volume)) {
    metrics.dollarVolM = Math.round((price * volume) / 1e6);
  }

  // Bid-ask spread in bps — only when both sides are quoted and ordered.
  if (isFinitePositive(bid) && isFinitePositive(ask) && ask >= bid) {
    const mid = (ask + bid) / 2;
    if (mid > 0) metrics.spreadBps = round(((ask - bid) / mid) * 10000, 1);
  }

  // Graham number (intrinsic value for defensive stocks) + margin of safety vs price.
  // Valid only for profitable names with positive book value (eps > 0, P/B > 0 → BVPS > 0).
  if (isFinitePositive(price) && isFiniteNumber(eps) && eps > 0 && isFinitePositive(pbRatio)) {
    const bookValuePerShare = price / pbRatio;
    const graham = Math.sqrt(22.5 * eps * bookValuePerShare);
    if (Number.isFinite(graham) && graham > 0) {
      metrics.grahamNumber = round(graham, 2);
      metrics.marginOfSafety = round(((graham - price) / price) * 100, 1);
    }
  }

  // % from the 52-week high — negative = trading below the high (pullback/drawdown depth).
  if (isFinitePositive(price) && isFinitePositive(fiftyTwoWeekHigh)) {
    metrics.pctFromHigh = round(((price - fiftyTwoWeekHigh) / fiftyTwoWeekHigh) * 100, 1);
  }

  // Reward:risk to the 52-week band — upside room to the high vs downside room from the low.
  // Only meaningful when the price sits strictly inside the band.
  if (isFinitePositive(fiftyTwoWeekHigh) && isFinitePositive(fiftyTwoWeekLow) && fiftyTwoWeekHigh > price && price > fiftyTwoWeekLow) {
    metrics.rr52w = round((fiftyTwoWeekHigh - price) / (price - fiftyTwoWeekLow), 2);
  }

  return metrics;
}
