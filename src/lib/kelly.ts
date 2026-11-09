/**
 * Fractional-Kelly sizing on realized payoff (downside-dispersion-aware, advisory only).
 *
 * Pure math module — no DB/network access. Consumed by `applyDeterministicSizing` in
 * `strategy.ts`, which supplies the realized win/loss payoff split from `performance.ts`'s
 * `aggregateClosedLots` (avgWinPct / avgLossPct / downsideDeviationPct, added alongside this
 * module). See `docs/reviews/2026-07-04-composite-expert-review.md:449` for the design note this
 * implements ("track per-thesis outcome dispersion ... penalize size for high-dispersion/
 * negatively-skewed theses ... pairs with fractional Kelly").
 *
 * House convention: this module NEVER fabricates a number. Every function returns `undefined`
 * (or an explicit `{ insufficient: true }` shape) when an input is missing or out of the domain
 * a real Kelly formula requires, rather than guessing.
 */

/**
 * Classic Kelly fraction: f* = p - (1-p)/b, where `p` is the win probability (0,1) and `b` is the
 * win/loss payoff ratio (avg win size / avg loss size, both expressed as positive magnitudes).
 *
 * Returns `undefined` when the inputs are outside the domain a real Kelly formula can use:
 * `b <= 0` (no loss data or a degenerate payoff ratio — Kelly is undefined without a loss side)
 * or `p` outside the open interval (0, 1) (a 0% or 100% win rate has no meaningful Kelly fraction
 * either, since it implies zero variance).
 *
 * The result is clamped to a minimum of 0: a negative edge (f* < 0) means "don't size this up
 * at all" — Kelly never recommends shorting the SIZE of a position you already decided to take,
 * only how large to make it. Callers that want to skip/veto a negative-edge thesis should use the
 * existing `shouldSkipNegativeExpectancy` gate; this function only ever informs sizing.
 */
export function kellyFraction(p: number, b: number): number | undefined {
  if (!Number.isFinite(p) || !Number.isFinite(b)) return undefined;
  if (!(p > 0) || !(p < 1)) return undefined;
  if (!(b > 0)) return undefined;
  const f = p - (1 - p) / b;
  return Math.max(0, f);
}

/**
 * Risk-adjusted-edge damping factor in [0, 1], monotonic in the ratio of mean edge to downside
 * dispersion (sigma_down). A thesis whose mean return is small — or negative — relative to its
 * downside deviation gets shrunk toward 0 (it wins on average only because of a few outsized
 * winners, with a fat, unpredictable left tail). A thesis with a strong, steady positive edge
 * (mean >= 2x sigma_down) keeps the full Kelly suggestion (penalty = 1).
 *
 * Precedence (checked in this exact order — resolves the avgReturnPct<=0 vs downsideDeviationPct<=0
 * ambiguity):
 *   1. avgReturnPct non-finite → penalty 0 (defensive).
 *   2. avgReturnPct <= 0 → penalty 0 UNCONDITIONALLY (no measured edge, or a net-loser bucket — the
 *      Kelly suggestion is fully damped regardless of downside dispersion). This takes precedence
 *      over the downsideDeviationPct<=0 short-circuit below, so a net loser never reads as "full
 *      Kelly" merely because the bucket happened to record no losing lots.
 *   3. downsideDeviationPct <= 0 with a POSITIVE edge (no losing lots — no downside signal to
 *      penalize against) → penalty 1 (no damping).
 *   4. Otherwise: ratio = avgReturnPct / downsideDeviationPct, clamped to [0, 2], divided by 2 to
 *      land in [0, 1].
 *
 * Endpoints: avgReturnPct <= 0 → 0. avgReturnPct >= 2 * downsideDeviationPct → 1 (full Kelly).
 * Strictly monotonically non-decreasing in avgReturnPct for a fixed positive downsideDeviationPct.
 */
export function dispersionPenalty(avgReturnPct: number, downsideDeviationPct: number): number {
  if (!Number.isFinite(avgReturnPct)) return 0;
  if (avgReturnPct <= 0) return 0; // net-loser / no-edge bucket: fully damped regardless of dispersion
  if (!Number.isFinite(downsideDeviationPct) || !(downsideDeviationPct > 0)) return 1;
  const ratio = avgReturnPct / downsideDeviationPct;
  const clamped = Math.max(0, Math.min(2, ratio));
  return clamped / 2;
}

/** Inputs a fractional-Kelly suggestion needs — the realized payoff split for one scorecard bucket. */
export interface KellyStatsInput {
  /** Shrunk or raw win rate, 0-100. */
  winRate: number;
  /** Mean returnPct over winning lots (positive number), from ThesisStat.avgWinPct. */
  avgWinPct?: number;
  /** Mean |returnPct| over losing lots (positive number), from ThesisStat.avgLossPct. */
  avgLossPct?: number;
  /** sqrt(mean(min(returnPct,0)^2)) over the bucket, from ThesisStat.downsideDeviationPct. */
  downsideDeviationPct?: number;
  /** Realized avg return (%) over the bucket — the "mean edge" fed to dispersionPenalty. */
  avgReturnPct: number;
  /** Closed-lot count backing this bucket. */
  trades: number;
}

export interface FractionalKellyOptions {
  /** Fraction of full Kelly to suggest (0.5 = "half-Kelly"). Default 0.5. */
  fraction?: number;
  /** Minimum closed lots required before a suggestion is produced. */
  minTrades: number;
}

export interface FractionalKellySuggestion {
  /** Suggested multiplier of the sizing scale (same [0,1] space as the existing deterministic sizer's bounded multiplier). */
  suggestedPctOfCeiling: number;
  /** Full Kelly fraction f* before the `fraction`/penalty scaling. */
  f: number;
  /** Win/loss payoff ratio used (avgWinPct / avgLossPct). */
  b: number;
  /** Win probability used (winRate / 100). */
  p: number;
  /** Dispersion-penalty damping factor applied, in [0, 1]. */
  penalty: number;
}

export interface FractionalKellyInsufficient {
  insufficient: true;
  trades: number;
  minTrades: number;
}

/**
 * Combine kellyFraction + dispersionPenalty into a single sizing suggestion, expressed as a
 * fraction of the SAME [0,1] sizing scale `applyDeterministicSizing`'s bounded multiplier already
 * uses (a multiplier of the policy's max opening order notional). Returns `{ insufficient: true }`
 * when the bucket has fewer than `minTrades` closed lots (mirrors the house sample-size gate,
 * `MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT` / `policy.tuning.minClosedLotsForWeightShift`) — the caller
 * should suppress any Kelly note/application entirely in that case, same as every other
 * "trust the stats" gate in this codebase. Returns `undefined` (not insufficient) when the sample
 * is large enough but the payoff ratio `b` isn't computable (no winners or no losers in the
 * bucket) — real Kelly math has no defined answer without both sides of the payoff, and this
 * module never fabricates one.
 */
export function fractionalKellySuggestion(
  stats: KellyStatsInput,
  opts: FractionalKellyOptions
): FractionalKellySuggestion | FractionalKellyInsufficient | undefined {
  const minTrades = opts.minTrades;
  if (stats.trades < minTrades) {
    return { insufficient: true, trades: stats.trades, minTrades };
  }
  if (stats.avgWinPct == null || stats.avgLossPct == null || !(stats.avgLossPct > 0)) {
    return undefined; // no payoff ratio computable — never fabricate b
  }
  const p = stats.winRate / 100;
  const b = stats.avgWinPct / stats.avgLossPct;
  const f = kellyFraction(p, b);
  if (f == null) return undefined;
  const fraction = opts.fraction ?? 0.5;
  const downsideDeviationPct = stats.downsideDeviationPct ?? 0;
  const penalty = dispersionPenalty(stats.avgReturnPct, downsideDeviationPct);
  const suggestedPctOfCeiling = Math.max(0, Math.min(1, f * fraction * penalty));
  return { suggestedPctOfCeiling, f, b, p, penalty };
}
