// Deterministic parametric pre-trade stress scenario — a receipt, never a gate. Answers "if the
// market drops N standard deviations today, what happens to this book (and to this book WITH the
// candidate order added)?" using a simple one-factor (market beta) shock model. No stress-testing
// engine existed in this codebase before this file (see maps/histcorr.md §6) — this is deliberately
// the simplest useful version: a single VIX-implied daily-sigma shock applied through each
// position's beta, not a full covariance-matrix VaR. Pure math, no I/O — callers supply positions,
// candidate, equity, and an optional VIX level; betas are passed in (sourced from market quotes by
// the caller, e.g. `quote.beta`) rather than fetched here.

export interface StressPositionInput {
  symbol: string;
  /** SIGNED market value: long positions positive, SHORT positions NEGATIVE (matches broker-reported
   *  EquityPosition.marketValue for Alpaca — see parseAlpacaPosition, which passes market_value
   *  through as-is and Alpaca reports it signed for shorts). A caller with an unsigned/absolute-value
   *  short market value MUST negate it before calling — this function trusts the sign it's given. */
  marketValue: number;
  /** Yahoo-sourced beta (quote.beta). Undefined falls back to 1.0 (market-average sensitivity). */
  beta?: number;
}

export interface StressCandidateInput {
  symbol: string;
  /** Unsigned proposed order notional (dollar amount, always >= 0). */
  notional: number;
  /** buy/short determine the SIGN applied to notional: buy = long exposure (+), short = short exposure (-). */
  side: "buy" | "short" | "sell" | "cover";
  beta?: number;
}

export interface StressScenarioInputs {
  positions: StressPositionInput[];
  candidate?: StressCandidateInput;
  equity: number;
  /** VIX level (e.g. 20 = 20%). Defaults to 20 (long-run-average VIX) when omitted/unavailable. */
  vix?: number;
  /** Shock size in standard deviations of the assumed daily market move (down). Default 2. */
  shockSigmas?: number;
}

export interface StressContributor {
  symbol: string;
  impactUsd: number;
}

export interface StressResult {
  /** The assumed one-day market shock, as a percentage (negative — a down move), e.g. -2.52. */
  shockPct: number;
  /** Total dollar impact on the CURRENT book (positions only, no candidate). Negative = a loss. */
  bookImpactUsd: number;
  /** bookImpactUsd as a percentage of equity. */
  bookImpactPctOfEquity: number;
  /** Total dollar impact on the book WITH the candidate's proposed position added. Equals
   *  bookImpactUsd when no candidate was supplied. */
  withCandidateImpactUsd: number;
  /** withCandidateImpactUsd as a percentage of equity. */
  withCandidateImpactPctOfEquity: number;
  /** The candidate's own marginal contribution to the shock (withCandidateImpactUsd - bookImpactUsd). */
  candidateMarginalUsd: number;
  /** Top 3 existing positions by |impact|, largest first. */
  topContributors: StressContributor[];
  /** True when more than half the considered positions had no `beta` and fell back to 1.0. */
  betasEstimated: boolean;
  /** Count of positions with an estimated (fallback) beta, and total positions considered. */
  betaEstimatedCount: number;
  betaTotalCount: number;
}

/**
 * Deterministic one-factor parametric stress scenario. daily sigma_mkt = (vix ?? 20) / sqrt(252) / 100
 * (VIX is an ANNUALIZED %, so this converts it to a daily fractional std-dev); shock = -shockSigmas *
 * sigma_mkt (always a DOWN move — stress scenarios test the downside). Per-position impact =
 * (beta ?? 1) * shock * marketValue: a short position (negative marketValue) under a DOWN shock
 * produces a POSITIVE impact (the hedge/short pays off), which is the correct sign — verified in
 * tests. The candidate's signed notional (buy=+, short=-; sell/cover contribute 0 since they reduce
 * rather than add exposure and this is a pre-trade OPENING stress receipt) is added the same way.
 * Returns undefined when equity <= 0 (can't express impact as % of a non-positive base).
 */
export function stressScenario(inputs: StressScenarioInputs): StressResult | undefined {
  const { positions, candidate, equity } = inputs;
  if (!(equity > 0)) return undefined;

  const vix = inputs.vix != null && Number.isFinite(inputs.vix) && inputs.vix > 0 ? inputs.vix : 20;
  const shockSigmas = inputs.shockSigmas != null && Number.isFinite(inputs.shockSigmas) && inputs.shockSigmas > 0 ? inputs.shockSigmas : 2;
  const dailySigmaPct = vix / Math.sqrt(252) / 100; // fractional (e.g. 0.0126 = 1.26%)
  const shockFraction = -shockSigmas * dailySigmaPct; // negative fraction (down move)
  const shockPct = shockFraction * 100;

  let betaEstimatedCount = 0;
  const betaTotalCount = positions.length;
  const contributors: StressContributor[] = [];
  let bookImpactUsd = 0;
  for (const p of positions) {
    const beta = typeof p.beta === "number" && Number.isFinite(p.beta) ? p.beta : 1;
    if (beta === 1 && (p.beta == null || !Number.isFinite(p.beta))) betaEstimatedCount++;
    const impactUsd = beta * shockFraction * p.marketValue;
    bookImpactUsd += impactUsd;
    contributors.push({ symbol: p.symbol, impactUsd });
  }
  const betasEstimated = betaTotalCount > 0 && betaEstimatedCount > betaTotalCount / 2;

  let candidateMarginalUsd = 0;
  if (candidate && candidate.notional > 0 && (candidate.side === "buy" || candidate.side === "short")) {
    const beta = typeof candidate.beta === "number" && Number.isFinite(candidate.beta) ? candidate.beta : 1;
    const signedNotional = candidate.side === "buy" ? candidate.notional : -candidate.notional;
    candidateMarginalUsd = beta * shockFraction * signedNotional;
  }
  const withCandidateImpactUsd = bookImpactUsd + candidateMarginalUsd;

  const topContributors = contributors
    .slice()
    .sort((a, b) => Math.abs(b.impactUsd) - Math.abs(a.impactUsd))
    .slice(0, 3);

  return {
    shockPct,
    bookImpactUsd,
    bookImpactPctOfEquity: (bookImpactUsd / equity) * 100,
    withCandidateImpactUsd,
    withCandidateImpactPctOfEquity: (withCandidateImpactUsd / equity) * 100,
    candidateMarginalUsd,
    topContributors,
    betasEstimated,
    betaEstimatedCount,
    betaTotalCount
  };
}
