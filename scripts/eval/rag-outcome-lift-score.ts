/**
 * Pure aggregation for the RAG outcome-lift scorecard (ST-4678).
 *
 * These are PURE functions of (persisted decision attributions, matured outcome grades). They split
 * matured closed decisions by whether their evidence attributions include a RAG retrieval and
 * summarize the realized outcome per bucket at each matured horizon. No DB, no network, no LLM, no
 * clock — the CLI in rag-outcome-lift.ts owns the SQLite read; this module owns the math so it is
 * unit-testable on synthetic rows (test/rag-outcome-lift.test.ts).
 *
 * Horizon mapping: the outcome engine grades daily horizons "1d" (1 trading day) and "1w" (5 trading
 * days) — see DAILY_HORIZONS in src/lib/outcome-horizons.ts. The scorecard reports "1d", "5d" (= the
 * persisted "1w" row) and "holding" (the headline realized return of the closed decision).
 */
import type { SocraticOutcomeHorizonRow, SocraticRagAttribution } from "../../src/lib/types";

export type LiftBucket = "rag" | "no-rag";
export type LiftHorizon = "1d" | "5d" | "holding";

export const LIFT_HORIZONS: readonly LiftHorizon[] = ["1d", "5d", "holding"];
export const LIFT_BUCKETS: readonly LiftBucket[] = ["rag", "no-rag"];

/** The minimal per-decision input the aggregator needs: a bucket flag and resolved horizon returns. */
export interface LiftDecisionInput {
  hasRag: boolean;
  /** Side-adjusted % return per horizon; a horizon that did not resolve is omitted. */
  returns: Partial<Record<LiftHorizon, number>>;
}

/** One (horizon, bucket) cell of the scorecard. Null statistics mean "no resolved samples". */
export interface LiftStats {
  horizon: LiftHorizon;
  bucket: LiftBucket;
  count: number;
  /** Samples whose side-adjusted return was strictly positive (the decided direction worked). */
  wins: number;
  mean: number | null;
  median: number | null;
  /** wins / count, 0..1. */
  winRate: number | null;
  /** 95% normal-approximation confidence interval on the mean return; null when count < 2. */
  ci95: [number, number] | null;
}

/** The persisted `socratic_decisions.outcome` JSON shape this scorecard reads (a structural subset). */
export interface PersistedOutcome {
  status?: string;
  returnPct?: number;
  outcomes?: readonly SocraticOutcomeHorizonRow[];
}

/**
 * True when the decision's persisted evidence attributions include a RAG retrieval — any attribution
 * carrying a stable chunk ref, evidence ref, doc type or source. This is the whole `rag_attributions`
 * ledger (#5466): filings RAG plus episodic analog/coaching retrievals. A decision with no such
 * attribution reasoned without retrieved evidence and lands in the "no-rag" bucket.
 */
export function hasRagRetrieval(
  attributions: readonly SocraticRagAttribution[] | undefined | null
): boolean {
  return (attributions ?? []).some(
    (attr) => Boolean(attr && (attr.chunkId || attr.evidenceRef || attr.docType || attr.source))
  );
}

/**
 * Map a persisted matured outcome to the scorecard's horizon returns. Only resolved (`ok`) horizon
 * rows with a finite return count; the headline `returnPct` is the "holding" leg. The persisted "1w"
 * row is the 5-trading-day window, reported as "5d". Never fabricates a return for an absent row.
 */
export function extractHorizonReturns(
  outcome: PersistedOutcome | undefined | null
): Partial<Record<LiftHorizon, number>> {
  const returns: Partial<Record<LiftHorizon, number>> = {};
  if (!outcome) return returns;
  if (typeof outcome.returnPct === "number" && Number.isFinite(outcome.returnPct)) {
    returns.holding = outcome.returnPct;
  }
  for (const row of outcome.outcomes ?? []) {
    if (!row || row.resolution !== "ok" || typeof row.returnPct !== "number" || !Number.isFinite(row.returnPct)) {
      continue;
    }
    if (row.horizon === "1d") returns["1d"] = row.returnPct;
    else if (row.horizon === "1w") returns["5d"] = row.returnPct;
  }
  return returns;
}

function meanOf(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Sample standard deviation (n - 1 denominator) about a known mean. */
function stddevOf(values: readonly number[], mean: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

const round4 = (value: number): number => Number(value.toFixed(4));

/** Summarize one (horizon, bucket) cell from its resolved return samples. */
export function summarizeBucket(horizon: LiftHorizon, bucket: LiftBucket, returns: readonly number[]): LiftStats {
  const count = returns.length;
  if (count === 0) {
    return { horizon, bucket, count: 0, wins: 0, mean: null, median: null, winRate: null, ci95: null };
  }
  const mean = meanOf(returns);
  const wins = returns.filter((value) => value > 0).length;
  let ci95: [number, number] | null = null;
  if (count >= 2) {
    const halfWidth = 1.96 * (stddevOf(returns, mean) / Math.sqrt(count));
    ci95 = [round4(mean - halfWidth), round4(mean + halfWidth)];
  }
  return {
    horizon,
    bucket,
    count,
    wins,
    mean: round4(mean),
    median: round4(medianOf(returns)),
    winRate: round4(wins / count),
    ci95
  };
}

/**
 * The full scorecard: for every horizon x bucket, the mean/median outcome, win rate, count and a 95%
 * normal-approximation CI on the mean. A horizon a decision did not resolve simply does not enter
 * that cell's sample — buckets are never padded with fabricated zeros.
 */
export function summarizeRagOutcomeLift(decisions: readonly LiftDecisionInput[]): LiftStats[] {
  const stats: LiftStats[] = [];
  for (const horizon of LIFT_HORIZONS) {
    for (const bucket of LIFT_BUCKETS) {
      const wantRag = bucket === "rag";
      const returns = decisions
        .filter((decision) => decision.hasRag === wantRag)
        .map((decision) => decision.returns[horizon])
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      stats.push(summarizeBucket(horizon, bucket, returns));
    }
  }
  return stats;
}