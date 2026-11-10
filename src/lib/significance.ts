// Rule significance testing (Jesse lesson, docs/oss-lessons.md §6).
//
// Before the learning loop credits a thesis tag with predictive power ("this rule works"),
// test whether the SAME trades would have done as well under a random grouping — the
// label-permutation null. The observed statistic is the bucket's mean realized returnPct;
// the null distribution is the mean of random same-size buckets drawn without replacement
// from the pooled closed-lot history. If a random bucket of the same size beats this one a
// third of the time, the tag's track record is not evidence — it is luck the LLM should
// weigh accordingly.
//
// Everything here is PURE and unit-tested in isolation (injectable rng for determinism).
// The wiring (post-mortem.ts) annotates the track-record fact and scales its confidence;
// it never hard-gates lesson writes — same "agent decides, logs everything" philosophy as
// the breakers, with the honesty carried in the sentence itself.

export interface PermutationBaselineResult {
  /** Mean returnPct of the real bucket. */
  observedMeanReturnPct: number;
  /** Mean of the permutation means (null center). */
  baselineMeanReturnPct: number;
  /** One-sided upper-tail p: P(random bucket mean >= observed) — the "positive edge is luck" probability. */
  pUpper: number;
  /** One-sided lower-tail p: P(random bucket mean <= observed) — the "this is genuinely worse" probability. */
  pLower: number;
  permutations: number;
  sampleSize: number;
  poolSize: number;
  /** False when the pool is too small to draw a meaningfully different random bucket
   *  (poolSize < sampleSize + MIN_POOL_EXCESS) — the baseline is not evidence either way. */
  meaningful: boolean;
  alpha: number;
}

export type TrackRecordDirection = "positive" | "negative" | "neutral";

const DEFAULT_PERMUTATIONS = 1000;
const DEFAULT_ALPHA = 0.05;
/** The pool must contain at least this many lots beyond the bucket itself, else every random
 *  draw is ~the bucket and the baseline says nothing. */
const MIN_POOL_EXCESS = 5;

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Label-permutation test: is the bucket's mean return distinguishable from a random same-size
 * bucket of the pooled history? p-values use the +1 correction so they never report exactly 0.
 * `random` is injectable for deterministic tests (defaults to Math.random).
 */
export function permutationSignificance(args: {
  /** returnPct series for the bucket under test (e.g. one thesis tag's closed lots). */
  bucket: number[];
  /** returnPct series for the FULL pooled history the bucket was drawn from (bucket included —
   *  the standard label-shuffle null: random same-size subset of the same pooled trades). */
  pool: number[];
  permutations?: number;
  alpha?: number;
  random?: () => number;
}): PermutationBaselineResult {
  const { bucket, pool } = args;
  const permutations = Math.max(100, Math.min(10_000, Math.floor(args.permutations ?? DEFAULT_PERMUTATIONS)));
  const alpha = typeof args.alpha === "number" && args.alpha > 0 && args.alpha < 1 ? args.alpha : DEFAULT_ALPHA;
  const random = args.random ?? Math.random;
  const observedMeanReturnPct = mean(bucket);
  const meaningful = bucket.length > 0 && pool.length >= bucket.length + MIN_POOL_EXCESS;
  if (!meaningful) {
    return {
      observedMeanReturnPct,
      baselineMeanReturnPct: observedMeanReturnPct,
      pUpper: 1,
      pLower: 1,
      permutations,
      sampleSize: bucket.length,
      poolSize: pool.length,
      meaningful: false,
      alpha
    };
  }

  let upper = 0;
  let lower = 0;
  let baselineSum = 0;
  const n = bucket.length;
  for (let p = 0; p < permutations; p += 1) {
    // Partial Fisher-Yates: draw n distinct lots from the pool without replacement.
    const indices = pool.map((_, i) => i);
    let sum = 0;
    for (let draw = 0; draw < n; draw += 1) {
      const pick = draw + Math.floor(random() * (indices.length - draw));
      [indices[draw], indices[pick]] = [indices[pick], indices[draw]];
      sum += pool[indices[draw]];
    }
    const permMean = sum / n;
    baselineSum += permMean;
    if (permMean >= observedMeanReturnPct) upper += 1;
    if (permMean <= observedMeanReturnPct) lower += 1;
  }

  return {
    observedMeanReturnPct,
    baselineMeanReturnPct: baselineSum / permutations,
    pUpper: (upper + 1) / (permutations + 1),
    pLower: (lower + 1) / (permutations + 1),
    permutations,
    sampleSize: n,
    poolSize: pool.length,
    meaningful: true,
    alpha
  };
}

/** The tail that matters for a given verdict direction. */
export function significancePValue(direction: TrackRecordDirection, result: PermutationBaselineResult): number | undefined {
  if (!result.meaningful || direction === "neutral") return undefined;
  return direction === "positive" ? result.pUpper : result.pLower;
}

/**
 * Honest one-sentence annotation for a track-record fact. Digits appear ONLY as the bare
 * p-value and permutation count — no %, $, shares/lots or sizing cues, so the learned-context
 * fail-closed numeric gate (classify.ts NUMERIC_RISK_PATTERN / cue numerics) does not reclassify
 * the fact as risk-adjacent. Returns undefined when there is no meaningful baseline or the
 * verdict is neutral (nothing to disclaim).
 */
export function significanceSentence(direction: TrackRecordDirection, result: PermutationBaselineResult): string | undefined {
  const p = significancePValue(direction, result);
  if (p === undefined) return undefined;
  const pStr = p.toFixed(3);
  const basis = `${result.permutations} permutations over the pooled closed-trade history`;
  if (direction === "positive") {
    return p < result.alpha
      ? `This beats a random-bucket label-permutation baseline (p=${pStr}, ${basis}) — unlikely to be luck.`
      : `This does NOT beat a random-bucket label-permutation baseline yet (p=${pStr}, ${basis}) — it could still be luck, so weigh it accordingly.`;
  }
  return p < result.alpha
    ? `This is significantly worse than a random-bucket label-permutation baseline (p=${pStr}, ${basis}) — the losses are unlikely to be bad luck alone.`
    : `This is not significantly worse than a random-bucket label-permutation baseline (p=${pStr}, ${basis}) — ordinary bad luck is not ruled out.`;
}

/**
 * Confidence for the ingested fact: validated edge earns more trust than the baseline 0.6;
 * a claim that does not beat luck earns LESS (still recorded — the annotation carries the
 * caveat — but discounted). Neutral verdicts and meaningless baselines keep the fallback.
 */
export function significanceConfidence(
  direction: TrackRecordDirection,
  result: PermutationBaselineResult,
  fallback: number = 0.6
): number {
  const p = significancePValue(direction, result);
  if (p === undefined) return fallback;
  return p < result.alpha ? 0.7 : 0.45;
}
