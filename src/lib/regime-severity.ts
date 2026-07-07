// Multi-signal, continuous regime SEVERITY — extends the coarse per-bucket constant in
// market-regime.ts (MARKET_REGIME_SEVERITY: crisis=1, risk-off=0.66, ...) which is driven
// VIX-only and never consumed downstream, into a blended [0,1] read across credit spreads
// (HY OAS), the VIX term structure (VIX/VIX3M backwardation), the 2s10s curve, and market
// breadth. ADVISORY-FIRST (docs/reviews/2026-07-04-expert-design-review.md E1/E4): this module
// never blocks anything on its own — it produces a number + explainable per-signal breakdown
// that (a) rides as prompt context to the Bull/Bear debate and (b) may OPTIONALLY taper an
// already-opt-in crisis cap in policy.ts when the owner explicitly turns that on.
//
// Deliberately dependency-free (no imports from ./db, ./macro, or anything else beyond types)
// so it stays client-safe and trivially unit-testable, matching market-regime.ts's own
// dependency-free design note.
//
// Money-path invariant (parity with market-regime.ts:56 "unknown severity 0"): a missing or
// thin macro feed must NEVER read as a confident high-severity regime. Every input signal is
// OPTIONAL and DROPPED (never imputed) when absent; when fewer than `minSignals` signals are
// present, the blend is not trusted at all — the result falls back to the caller-supplied
// `baseRegime`'s coarse severity (0 when baseRegime is also absent/"unknown").

import type { MarketRegime } from "./market-regime";
import { MARKET_REGIME_SEVERITY } from "./market-regime";

/** Raw inputs — every field optional; a missing signal is DROPPED, never imputed. */
export interface RegimeSeverityInputs {
  /** macro.vix parsed (points). */
  vix?: number;
  /** macroDerived.vixTermStructure (VIX / VIX3M). >1 = backwardation (acute near-term stress). */
  vixTermStructure?: number;
  /** macro.hyCreditSpread parsed (percentage points, ICE BofA US HY OAS). */
  hyCreditSpread?: number;
  /**
   * OPTIONAL 1-week change in hyCreditSpread (pp). Deferred to a follow-up lane (see spec §4) —
   * accepted here and simply dropped when absent so a future wire-up needs no signature change.
   */
  hyCreditSpread1wChange?: number;
  /** macroDerived.curve2s10s (pp; 10Y minus 2Y). <0 = inverted (recession signal / stress). */
  curve2s10s?: number;
  /** marketScan.breadthPct / marketInternals.breadthPct (0-100, % of full screener advancing). */
  breadthPct?: number;
  /** classifyMarketRegime(macro).regime — fallback anchor when the blend is degraded. */
  baseRegime?: MarketRegime;
}

export interface RegimeSubScore {
  key: "vix" | "termStructure" | "hyCreditSpread" | "curve2s10s" | "breadth";
  /** The observed raw value for this signal. */
  raw: number;
  /** Its [0,1] risk-off contribution after the piecewise-linear ramp. */
  contribution: number;
  /** Its weight in the blend (post-renormalization weights are NOT reflected here — this is the configured weight). */
  weight: number;
}

export interface RegimeSeverityResult {
  /** Continuous risk-off severity in [0,1]. Monotone with stress. */
  severity: number;
  /** Bucketed label AFTER hysteresis (when hysteresis is applied) or the instantaneous bucket. */
  regime: MarketRegime;
  /** Per-signal breakdown — the audit receipt payload / prompt evidence. */
  subScores: RegimeSubScore[];
  /** Signals that were present and actually scored (for honest provenance). */
  contributingSignals: string[];
  /** Count of scored signals; drives the degraded fallback below. */
  signalCount: number;
  /** True when too few signals were available to trust the blend (falls back to baseRegime severity). */
  degraded: boolean;
}

export interface HysteresisState {
  lastRegime: MarketRegime;
  ticksInPendingBand: number;
  pendingRegime: MarketRegime | null;
}

/** Config knobs (all defaulted; overridable via policy). */
export interface RegimeSeverityOptions {
  weights?: Partial<Record<RegimeSubScore["key"], number>>;
  /** Below this many present signals, fall back to baseRegime severity/regime (default 2). */
  minSignals?: number;
  /** Hysteresis: consecutive ticks required to flip regime (default 2). */
  minTicksToFlip?: number;
}

const DEFAULT_MIN_SIGNALS = 2;
const DEFAULT_MIN_TICKS_TO_FLIP = 2;

/** Default weights — sum to 1.0. Overridable via opts.weights (renormalized over present signals). */
const DEFAULT_WEIGHTS: Record<RegimeSubScore["key"], number> = {
  vix: 0.3,
  termStructure: 0.2,
  hyCreditSpread: 0.25,
  curve2s10s: 0.1,
  breadth: 0.15
};

/** Bucket band edges — severity >= edge maps to the given regime. Checked highest-first. */
const CRISIS_EDGE = 0.75;
const RISK_OFF_EDGE = 0.5;
const CAUTIOUS_INVERTED_EDGE = 0.28;
const RISK_ON_EDGE = 0.1;

/**
 * Piecewise-linear ramp: maps `raw` to [0,1] over the (from -> to) interval, clamped at both
 * ends. `from` may be greater than `to` (a decreasing ramp, e.g. breadth or curve2s10s) — the
 * direction is inferred from which end is larger, so callers never need to pre-invert.
 */
function ramp(raw: number, from: number, to: number): number {
  if (from === to) return 0;
  const t = (raw - from) / (to - from);
  return Math.min(1, Math.max(0, t));
}

/** Signal -> [0,1] risk-off contribution ramps. Constants documented inline; all overridable via weights. */
function vixContribution(vix: number): number {
  return ramp(vix, 12, 40);
}
function termStructureContribution(ts: number): number {
  return ramp(ts, 0.95, 1.15);
}
function hyCreditSpreadContribution(hy: number): number {
  return ramp(hy, 3.0, 8.0);
}
function curve2s10sContribution(curve: number): number {
  // Decreasing ramp: +0.5 (steep, no stress) -> -1.0 (deeply inverted, high stress).
  return ramp(curve, 0.5, -1.0);
}
function breadthContribution(breadth: number): number {
  // Decreasing ramp: 55% advancing (healthy) -> 25% advancing (narrow/deteriorating).
  return ramp(breadth, 55, 25);
}

/** Map a continuous [0,1] severity to a MarketRegime bucket. Lower band edges are INCLUSIVE
 *  (`>=`): severity 0.5 is risk-off, 0.28 is cautious-inverted, 0.75 is crisis. Exported so the
 *  edge-inclusivity is unit-tested directly with exact severities (an end-to-end blend can only hit
 *  an edge float-approximately). Feeds only ADVISORY, default-off consumers — never a hard gate. */
export function bucketFromSeverity(severity: number, breadthPresent: boolean): MarketRegime {
  if (severity >= CRISIS_EDGE) return "crisis";
  if (severity >= RISK_OFF_EDGE) return "risk-off";
  if (severity >= CAUTIOUS_INVERTED_EDGE) return "cautious-inverted";
  // Match the existing classifier's asymmetry: only call it "risk-on" when we have positive
  // evidence of a healthy tape (breadth), not just an absence of stress signals.
  if (severity < RISK_ON_EDGE && breadthPresent) return "risk-on";
  return "neutral";
}

/**
 * Pure. No hysteresis — the instantaneous read from whatever signals are present this tick.
 * Missing signals are dropped (never imputed) and the remaining weights are renormalized so
 * the blend stays a proper weighted mean over what actually fed it.
 */
export function scoreRegimeSeverity(
  inputs: RegimeSeverityInputs,
  opts?: RegimeSeverityOptions
): RegimeSeverityResult {
  const weights: Record<RegimeSubScore["key"], number> = { ...DEFAULT_WEIGHTS, ...opts?.weights };
  const minSignals = opts?.minSignals ?? DEFAULT_MIN_SIGNALS;

  const subScores: RegimeSubScore[] = [];

  if (typeof inputs.vix === "number" && Number.isFinite(inputs.vix)) {
    subScores.push({ key: "vix", raw: inputs.vix, contribution: vixContribution(inputs.vix), weight: weights.vix });
  }
  if (typeof inputs.vixTermStructure === "number" && Number.isFinite(inputs.vixTermStructure)) {
    subScores.push({
      key: "termStructure",
      raw: inputs.vixTermStructure,
      contribution: termStructureContribution(inputs.vixTermStructure),
      weight: weights.termStructure
    });
  }
  if (typeof inputs.hyCreditSpread === "number" && Number.isFinite(inputs.hyCreditSpread)) {
    subScores.push({
      key: "hyCreditSpread",
      raw: inputs.hyCreditSpread,
      contribution: hyCreditSpreadContribution(inputs.hyCreditSpread),
      weight: weights.hyCreditSpread
    });
  }
  if (typeof inputs.curve2s10s === "number" && Number.isFinite(inputs.curve2s10s)) {
    subScores.push({
      key: "curve2s10s",
      raw: inputs.curve2s10s,
      contribution: curve2s10sContribution(inputs.curve2s10s),
      weight: weights.curve2s10s
    });
  }
  if (typeof inputs.breadthPct === "number" && Number.isFinite(inputs.breadthPct)) {
    subScores.push({
      key: "breadth",
      raw: inputs.breadthPct,
      contribution: breadthContribution(inputs.breadthPct),
      weight: weights.breadth
    });
  }
  // hyCreditSpread1wChange: accepted on the input type for forward-compat (spec §4) but
  // deliberately not scored in v1 — no ramp/weight is defined for it yet.

  const signalCount = subScores.length;
  const baseRegime = inputs.baseRegime ?? "unknown";

  if (signalCount < minSignals) {
    // Thin feed: never let a partial blend fabricate elevated risk. Fall back to the caller's
    // coarse anchor (0 when baseRegime is itself absent/"unknown") — same invariant as
    // market-regime.ts:56.
    return {
      severity: MARKET_REGIME_SEVERITY[baseRegime],
      regime: baseRegime,
      subScores,
      contributingSignals: subScores.map((s) => s.key),
      signalCount,
      degraded: true
    };
  }

  const totalWeight = subScores.reduce((sum, s) => sum + s.weight, 0);
  const severity =
    totalWeight > 0
      ? subScores.reduce((sum, s) => sum + s.weight * s.contribution, 0) / totalWeight
      : 0;

  const breadthPresent = subScores.some((s) => s.key === "breadth");
  const regime = bucketFromSeverity(severity, breadthPresent);

  return {
    severity,
    regime,
    subScores,
    contributingSignals: subScores.map((s) => s.key),
    signalCount,
    degraded: false
  };
}

/** Ordinal rank so hysteresis can compare "is the pending regime more severe than the last one". */
const REGIME_RANK: Record<MarketRegime, number> = {
  "risk-on": 0,
  neutral: 1,
  unknown: 1,
  "cautious-inverted": 2,
  "risk-off": 3,
  crisis: 4
};

/**
 * Pure. Applies N-tick hysteresis to a fresh instantaneous result given prior state, so a single
 * one-tick spike (a VIX head-fake) does not flip the persisted/consumed regime — the read must
 * repeat for `minTicksToFlip` consecutive calls in the new band before the regime actually moves.
 * The SEVERITY number itself is always the fresh instantaneous value (so the prompt/receipt still
 * shows the real read); only `result.regime` is hysteresis-smoothed.
 */
export function applyRegimeHysteresis(
  fresh: RegimeSeverityResult,
  prior: HysteresisState | undefined,
  minTicksToFlip: number = DEFAULT_MIN_TICKS_TO_FLIP
): { result: RegimeSeverityResult; nextState: HysteresisState } {
  const lastRegime = prior?.lastRegime ?? fresh.regime;

  // No change in instantaneous bucket vs the confirmed regime: reset any pending flip.
  if (fresh.regime === lastRegime) {
    return {
      result: { ...fresh, regime: lastRegime },
      nextState: { lastRegime, ticksInPendingBand: 0, pendingRegime: null }
    };
  }

  const stillPending = prior?.pendingRegime === fresh.regime;
  const ticksInPendingBand = stillPending ? (prior?.ticksInPendingBand ?? 0) + 1 : 1;

  if (ticksInPendingBand >= Math.max(1, minTicksToFlip)) {
    // Confirmed: the new bucket has now been read `minTicksToFlip` times in a row — flip.
    return {
      result: { ...fresh, regime: fresh.regime },
      nextState: { lastRegime: fresh.regime, ticksInPendingBand: 0, pendingRegime: null }
    };
  }

  // Not yet confirmed: keep reporting the last confirmed regime, but track the pending band.
  return {
    result: { ...fresh, regime: lastRegime },
    nextState: { lastRegime, ticksInPendingBand, pendingRegime: fresh.regime }
  };
}

/** Exposed for tests / diagnostics that want to reason about band ordering without re-deriving it. */
export function regimeRank(regime: MarketRegime): number {
  return REGIME_RANK[regime];
}
