// Item 2 (Workstream B): a CACHED go/no-go gate for the congressional scan signal, backed by the
// statistical validation in `congress-score-eval.ts` (placebo-IC, t-stat, marginal-IC, quantile spread).
//
// DEFAULT OFF: with `policy.tuning.congressGoNoGoGating` unset the multiplier is always 1 (no change) —
// the congress term is applied unconditionally exactly as today. When the flag is on, a "no-go" verdict
// (the eval's own goNoGo.pass === false) zeroes the congress contribution so a statistically-unvalidated
// signal can no longer lift a name into the candidate set or up the composite.
//
// The verdict is CACHED in the `settings` table (written by a periodic refresh — the offline eval script
// or `refreshCongressScoreVerdict`) and read cheaply at scan time; the expensive OHLC-backed evaluation
// never runs inside a scan cycle.

import { getInternalSetting, setInternalSetting } from "./db-settings";
import {
  buildCongressScoreObservations,
  evaluateCongressScore,
  type CongressScoreEvaluation,
  type CongressScoreOHLCFetcher
} from "./congress-score-eval";
import { getPolicy } from "./db";

/** How stale a cached verdict may be before it is treated as absent (fail-open: no gating). */
export const CONGRESS_VERDICT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Three-way verdict (panel B2). The eval's binary `goNoGo.pass` conflates two very different failures:
 *  - PASS: the signal cleared every statistical bar → keep the congress term (multiplier 1).
 *  - FAIL_SIGNIFICANCE: ENOUGH data, but the signal FAILED a significance bar (non-positive IC, t-stat < 2,
 *    negative quantile spread, placebo not beaten) → down-weight/zero the congress term (multiplier 0).
 *  - INSUFFICIENT: too little data to judge (too few obs/dates/tickers/top-bucket, no benchmark) → stay
 *    NEUTRAL (multiplier 1), because a fresh/data-poor account would otherwise become a permanent congress
 *    kill-switch. This is the critical distinction: only a real, data-backed significance failure gates.
 */
export type CongressVerdictClass = "PASS" | "FAIL_SIGNIFICANCE" | "INSUFFICIENT";

/** Reason fragments that indicate DATA insufficiency (not a significance failure). */
const INSUFFICIENCY_MARKERS = ["insufficient observations", "insufficient dates", "insufficient distinct tickers", "insufficient top-bucket", "benchmarkReturn is required"];

export interface CongressScoreVerdict {
  /** Three-way classification (panel B2). */
  verdict: CongressVerdictClass;
  /** True only when verdict === "PASS" (kept for back-compat / quick reads). */
  pass: boolean;
  /** ISO timestamp the verdict was computed. */
  computedAt: string;
  /** Reasons the verdict is not PASS (empty when PASS). */
  reasons: string[];
  /** Compact stats for UI surfacing. */
  stats: {
    observations: number;
    dates: number;
    tickers: number;
    rankICMeanIC: number;
    rankICTStat: number;
    marginalICMeanIC?: number;
    topMinusBottomReturn: number | null;
    placeboDeltaIC?: number;
  };
}

/**
 * Classify an evaluation's go/no-go into the three-way verdict. PASS when the eval passed. Otherwise, if
 * ANY failure reason is a data-insufficiency marker → INSUFFICIENT (neutral); else the failures are genuine
 * significance failures on adequate data → FAIL_SIGNIFICANCE (gate). Pure.
 */
export function classifyCongressVerdict(pass: boolean, reasons: string[]): CongressVerdictClass {
  if (pass) return "PASS";
  const hasInsufficiency = reasons.some((r) => INSUFFICIENCY_MARKERS.some((m) => r.includes(m)));
  return hasInsufficiency ? "INSUFFICIENT" : "FAIL_SIGNIFICANCE";
}

export interface CongressScoreVerdictRead extends CongressScoreVerdict {
  /** True when the cached verdict is older than CONGRESS_VERDICT_MAX_AGE_MS (treated as unavailable). */
  stale: boolean;
}

function settingsKey(userId: string): string {
  return `congress_score_verdict:${userId}`;
}

/** Persist a verdict derived from a full evaluation. Callable from the offline eval or an admin refresh. */
export function storeCongressScoreVerdict(userId: string, evaluation: CongressScoreEvaluation, now: number = Date.now()): CongressScoreVerdict {
  const cls = classifyCongressVerdict(evaluation.goNoGo.pass, evaluation.goNoGo.reasons);
  const verdict: CongressScoreVerdict = {
    verdict: cls,
    pass: cls === "PASS",
    computedAt: new Date(now).toISOString(),
    reasons: evaluation.goNoGo.reasons,
    stats: {
      observations: evaluation.observations,
      dates: evaluation.dates,
      tickers: evaluation.tickers,
      rankICMeanIC: evaluation.rankIC.meanIC,
      rankICTStat: evaluation.rankIC.tStat,
      marginalICMeanIC: evaluation.marginalIC?.meanIC,
      topMinusBottomReturn: evaluation.topMinusBottomReturn,
      placeboDeltaIC: evaluation.placeboDeltaIC
    }
  };
  setInternalSetting(settingsKey(userId), verdict);
  return verdict;
}

/**
 * Read the cached verdict for a user. Returns undefined when none is stored. A stored verdict older than
 * CONGRESS_VERDICT_MAX_AGE_MS is returned with `stale: true` so callers can fail-open (no gating) rather
 * than gate on a months-old validation.
 */
export function readCongressScoreVerdict(userId: string = "local", now: number = Date.now()): CongressScoreVerdictRead | undefined {
  const stored = getInternalSetting<CongressScoreVerdict>(settingsKey(userId));
  if (!stored || typeof stored.pass !== "boolean") return undefined;
  const computedMs = Date.parse(stored.computedAt);
  const stale = !Number.isFinite(computedMs) || now - computedMs > CONGRESS_VERDICT_MAX_AGE_MS;
  return { ...stored, stale };
}

/**
 * The multiplier to apply to the congressional contribution in scan scoring. Pure — no I/O.
 *  - gating OFF (default) → always 1 (no change).
 *  - gating ON, verdict absent or STALE → 1 (fail-open: never gate on missing/old validation).
 *  - gating ON, fresh PASS → 1 (keep the term).
 *  - gating ON, fresh INSUFFICIENT → 1 (NEUTRAL — data-poverty must not become a permanent kill-switch).
 *  - gating ON, fresh FAIL_SIGNIFICANCE → 0 (the signal failed a significance bar on adequate data → gate).
 *
 * Legacy cached verdicts written before B2 (no `verdict` field) fall back to the old binary pass semantics.
 */
export function congressGateMultiplier(verdict: CongressScoreVerdictRead | undefined, gatingEnabled: boolean): number {
  if (!gatingEnabled) return 1;
  if (!verdict || verdict.stale) return 1;
  const cls = verdict.verdict ?? (verdict.pass ? "PASS" : "FAIL_SIGNIFICANCE");
  return cls === "FAIL_SIGNIFICANCE" ? 0 : 1;
}

/**
 * Convenience: resolve the effective congress multiplier for a user from policy + the cached verdict.
 * Reads the cache (cheap settings lookup); the expensive evaluation is never triggered here.
 */
export function resolveCongressGateMultiplier(userId: string, gatingEnabled: boolean, now: number = Date.now()): { multiplier: number; verdict?: CongressScoreVerdictRead } {
  if (!gatingEnabled) return { multiplier: 1 };
  const verdict = readCongressScoreVerdict(userId, now);
  return { multiplier: congressGateMultiplier(verdict, gatingEnabled), verdict };
}

export interface RefreshCongressScoreVerdictOptions {
  horizonDays?: number;
  auditLimit?: number;
  now?: number;
  /** Fixed placebo seed so the placebo control always fires (deterministic in tests). */
  placeboSeed?: number;
  /** Injectable OHLC fetcher (for offline/fixture use). Defaults to the real daily fetch. */
  fetchOHLC?: CongressScoreOHLCFetcher;
}

/**
 * P2-8: cadence-callable refresher that moves the expensive OHLC-backed congress evaluation OFF the scan hot
 * path. Computes `evaluateCongressScore` from `buildCongressScoreObservations` and PERSISTS the go/no-go
 * verdict (via `storeCongressScoreVerdict`) so `market.ts` reads the cached verdict cheaply. Honors the
 * operator's `congressRequireTopBucketPositive` flag (P2-3). A scheduler/cron or admin refresh calls this; the
 * scan cycle never triggers the eval inline. Returns the stored verdict. This does NOT itself gate anything —
 * gating is governed by `policy.tuning.congressGoNoGoGating` at read time.
 */
export async function refreshCongressScoreVerdict(
  userId: string = "local",
  options: RefreshCongressScoreVerdictOptions = {}
): Promise<CongressScoreVerdict> {
  const now = options.now ?? Date.now();
  const requireTopBucketPositive = getPolicy(userId).tuning?.congressRequireTopBucketPositive ?? false;
  const observations = await buildCongressScoreObservations(userId, {
    horizonDays: options.horizonDays,
    auditLimit: options.auditLimit,
    now,
    ...(options.fetchOHLC ? { fetchOHLC: options.fetchOHLC } : {})
  });
  const evaluation = evaluateCongressScore(observations, {
    ...(options.placeboSeed !== undefined ? { placeboSeed: options.placeboSeed } : {}),
    requireTopBucketPositive
  });
  return storeCongressScoreVerdict(userId, evaluation, now);
}
