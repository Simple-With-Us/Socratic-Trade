// Multi-signal regime severity scorer (Lane 5 — credit spreads + VIX term structure + breadth).
//
// `MARKET_REGIME_SEVERITY` (market-regime.ts) is a flat per-enum-bucket lookup with zero
// consumers today — it only reflects VIX + the yield curve (the two inputs `classifyMarketRegime`
// already sees). This module is a NEW, parallel, dependency-light blender that widens the signal
// set (VIX term structure, HY credit spread, market breadth, VVIX, SKEW) into one continuous
// [0, 1] severity score, WITHOUT touching `market-regime.ts`'s pinned enum/label/severity
// contracts or its dependency-free-module guarantee (this file is not imported by it and does
// not import it for values it doesn't already need — see below).
//
// Design contract:
//   - Pure function of its inputs. No fetches, no DB, and no imports beyond market-regime.ts's
//     pinned exports (the `MarketRegime` type and the `MARKET_REGIME_SEVERITY` floor lookup) — so
//     this file stays as dependency-light as market-regime.ts itself.
//   - Never fabricates: a missing input is simply absent from `components` and its weight is
//     redistributed across whatever IS available (never defaulted to a guessed number).
//   - The classified enum's own severity (`MARKET_REGIME_SEVERITY[regime]`) is a FLOOR, not an
//     input to the blend — the composite can only ADD caution vs. today's channel, never dilute
//     a crisis reading with calm continuous signals.
//   - Zero available continuous inputs → severity collapses to the floor, `inputsUsed: 0`.
//
// This module intentionally does NOT change any gate/cap behavior (crisis cap, bear filter,
// escalation trigger) — it is a new advisory/receipt channel only. See
// docs/rollouts/2026-07-05-multi-signal-regime-scorer.md for the wiring decisions and the
// explicit "feeding caps" scoping deferral.

import type { MarketRegime } from "./market-regime";
import { MARKET_REGIME_SEVERITY } from "./market-regime";

export interface RegimeSeverityInputs {
  /** Classified enum bucket — anchors the floor (see module docblock). */
  regime: MarketRegime;
  /** CBOE VIX level. */
  vix?: number;
  /** VIX ÷ 3-month VIX (macro-metrics.ts `vixTermStructure`). >1 = backwardation (acute stress). */
  vixTermStructure?: number;
  /** ICE BofA US High-Yield OAS, in percent (MacroData.hyCreditSpread parsed). */
  hyCreditSpreadPct?: number;
  /** 0-100 share of advancing names (MarketScan.breadthPct or MarketSignals.marketBreadthPct). */
  breadthPct?: number;
  /** Cboe VVIX — volatility of VIX. */
  vvix?: number;
  /** Cboe SKEW — tail-risk / crash-hedging demand. */
  skew?: number;
}

export interface RegimeSeverityComponent {
  signal: string;
  /** Raw input value as provided. */
  value: number;
  /** Normalized to [0, 1], monotonic toward risk (higher = more stressed). */
  normalized: number;
  /** Weight actually applied after renormalizing over available inputs. */
  weight: number;
}

export interface RegimeSeverityResult {
  /** Final blended severity in [0, 1]: max(enum floor, weighted blend of available signals). */
  severity: number;
  /** Per-signal breakdown of every input that was actually available and used. */
  components: RegimeSeverityComponent[];
  /** Count of inputs that were defined/finite and participated in the blend. */
  inputsUsed: number;
  /** Count of inputs this function knows how to use (fixed at 6 — the signals listed above). */
  inputsAvailable: number;
  /** The enum severity floor applied (MARKET_REGIME_SEVERITY[regime]). */
  floor: number;
}

/** Linearly maps `value` from [loAt0, hiAt1] to a clamped [0, 1], monotonic toward risk. */
function normalizeLinear(value: number, loAt0: number, hiAt1: number): number {
  if (hiAt1 === loAt0) return 0;
  const t = (value - loAt0) / (hiAt1 - loAt0);
  return Math.min(1, Math.max(0, t));
}

/** Base (pre-renormalization) weights — see lane spec for the rationale behind each figure. */
const BASE_WEIGHTS: Record<string, number> = {
  vix: 0.3,
  vixTermStructure: 0.2,
  hyCreditSpreadPct: 0.2,
  breadthPct: 0.15,
  vvix: 0.1,
  skew: 0.05
};

const SIGNAL_KEYS = Object.keys(BASE_WEIGHTS) as Array<keyof typeof BASE_WEIGHTS>;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Normalize each available signal to [0, 1] (monotonic toward risk), per the thresholds pinned
 * in the lane spec:
 *   vix:               0 @ <=12,   1 @ >=40
 *   vixTermStructure:  0 @ <=0.85, 1 @ >=1.10   (backwardation = acute stress)
 *   hyCreditSpreadPct: 0 @ <=3.0,  1 @ >=8.0
 *   breadthPct:        INVERTED — 0 @ >=60,   1 @ <=25 (low breadth = stress)
 *   vvix:              0 @ <=80,  1 @ >=140
 *   skew:              0 @ <=115, 1 @ >=155
 */
function normalizeSignal(key: keyof typeof BASE_WEIGHTS, value: number): number {
  switch (key) {
    case "vix":
      return normalizeLinear(value, 12, 40);
    case "vixTermStructure":
      return normalizeLinear(value, 0.85, 1.1);
    case "hyCreditSpreadPct":
      return normalizeLinear(value, 3.0, 8.0);
    case "breadthPct":
      // Inverted: low breadth is high stress, so map hiAt1(25) < loAt0(60).
      return normalizeLinear(value, 60, 25);
    case "vvix":
      return normalizeLinear(value, 80, 140);
    case "skew":
      return normalizeLinear(value, 115, 155);
    default:
      return 0;
  }
}

/**
 * Blend credit spreads + VIX term structure + breadth (+ VVIX/SKEW when available) into one
 * continuous [0, 1] severity reading, floored by the classified enum's own severity so the
 * composite can only add caution versus today's boolean-gate channel, never dilute a crisis
 * reading. Pure/synchronous — safe to call inline; callers should still wrap in try/catch per
 * house convention (a scorer failure must never fail a strategy run).
 */
export function computeMultiSignalSeverity(inputs: RegimeSeverityInputs): RegimeSeverityResult {
  const floor = MARKET_REGIME_SEVERITY[inputs.regime] ?? 0;

  const raw: Partial<Record<keyof typeof BASE_WEIGHTS, number>> = {
    vix: inputs.vix,
    vixTermStructure: inputs.vixTermStructure,
    hyCreditSpreadPct: inputs.hyCreditSpreadPct,
    breadthPct: inputs.breadthPct,
    vvix: inputs.vvix,
    skew: inputs.skew
  };

  const available = SIGNAL_KEYS.filter((k) => isFiniteNumber(raw[k]));
  const totalAvailableWeight = available.reduce((sum, k) => sum + BASE_WEIGHTS[k], 0);

  const components: RegimeSeverityComponent[] = [];
  let weightedBlend = 0;

  if (available.length > 0 && totalAvailableWeight > 0) {
    for (const key of available) {
      const value = raw[key] as number;
      const normalized = normalizeSignal(key, value);
      const weight = BASE_WEIGHTS[key] / totalAvailableWeight; // renormalized over AVAILABLE inputs only
      components.push({ signal: key, value, normalized, weight });
      weightedBlend += normalized * weight;
    }
  }

  const severity = Math.min(1, Math.max(floor, weightedBlend));

  return {
    severity,
    components,
    inputsUsed: available.length,
    inputsAvailable: SIGNAL_KEYS.length,
    floor
  };
}
