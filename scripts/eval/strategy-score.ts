/**
 * Deterministic scorers for the strategy (Bull/Bear) offline eval — Chat A item 2.
 *
 * These are PURE functions of (fixture proposals, case universe, case evidence, policy flags). They
 * re-implement — offline, without any LLM/network — the hard money-path invariants the production
 * code enforces in src/lib/policy.ts + src/lib/strategy.ts, so a prompt/schema change that lets a
 * violating output through is caught by the eval. No fetch, no DB, no clock.
 */

export interface ScoreResult {
  pass: boolean;
  /** 0..1 (binary here — these are hard invariants). */
  score: number;
  detail: string;
}

/** A model-output proposal fixture — the subset of TradeProposal fields the scorers read. */
export interface ProposalFixture {
  symbol: string;
  side: "buy" | "sell" | "short" | "cover";
  type?: "market" | "limit" | "stop_market" | "stop_limit";
  stopPrice?: number | null;
  bracketStopLoss?: number | null;
}

/** Per-symbol structured evidence the Bull prompt claims to reason from (subset of MarketQuote). */
export interface EvidenceEntry {
  score?: number;
  medianScore?: number;
  fcfYield?: number;
  debtToEquity?: number;
}

export interface VetoThresholds {
  fcfYieldFloorPct?: number;
  debtToEquityCeiling?: number;
}

function norm(symbol: string): string {
  return String(symbol ?? "").trim().toUpperCase();
}

const isOpening = (side: ProposalFixture["side"]): boolean => side === "buy" || side === "short";

function hasStop(p: ProposalFixture): boolean {
  // A short's mandatory protective stop must come from an explicit stop price / bracket stop-loss.
  // The ENTRY order's own type (a stop_market/stop_limit entry) is NOT a post-entry stop-loss, so a
  // stopless short entered as a stop order must not count as protected (that would let the offline
  // eval report a stopless short as passing and give false confidence in prompt/schema changes).
  // Require a FINITE POSITIVE value — malformed model output like `stopPrice: 0` or a negative bracket
  // stop is not a real protective stop and must not pass the invariant.
  const isPositive = (v: number | null | undefined): boolean => typeof v === "number" && Number.isFinite(v) && v > 0;
  return isPositive(p.stopPrice) || isPositive(p.bracketStopLoss);
}

/**
 * Scorer 1 — never propose an OFF-UNIVERSE symbol. Mirrors the policy allowlist gate (policy.ts
 * "X is not in the allowed universe"). Only OPENING sides (buy/short) are checked; sells/covers are
 * risk-reducing exits and are intentionally exempt.
 */
export function scoreNoOffUniverse(proposals: ProposalFixture[], universe: string[]): ScoreResult {
  const allowed = new Set(universe.map(norm));
  const offenders = proposals.filter((p) => isOpening(p.side) && !allowed.has(norm(p.symbol)));
  return {
    pass: offenders.length === 0,
    score: offenders.length === 0 ? 1 : 0,
    detail: offenders.length === 0
      ? "all opening proposals are in the allowed universe"
      : `off-universe opens: ${offenders.map((p) => `${p.side} ${p.symbol}`).join(", ")}`
  };
}

/**
 * Scorer 2 — every SHORT carries a stop (and no short when shorting is disabled). Mirrors the Bull
 * prompt mandate ("Every short MUST carry a mandatory stop-loss") + the policy short-stop gate.
 */
export function scoreShortsHaveStop(proposals: ProposalFixture[], shortSellingEnabled: boolean): ScoreResult {
  const shorts = proposals.filter((p) => p.side === "short");
  const bad = shorts.filter((p) => !shortSellingEnabled || !hasStop(p));
  return {
    pass: bad.length === 0,
    score: bad.length === 0 ? 1 : 0,
    detail: bad.length === 0
      ? "every short carries a stop (or none proposed)"
      : `${!shortSellingEnabled ? "shorts emitted while disabled / " : ""}stopless shorts: ${bad.map((p) => p.symbol).join(", ")}`
  };
}

/**
 * Scorer 3 — reject BUYS that CONTRADICT structured evidence. Mirrors deterministicBearFilter's
 * fundamentals/regime vetoes: a cash-burning buy (fcfYield below floor), an over-levered buy
 * (debt/equity above ceiling), or a below-median buy in a risk-off/crisis regime.
 */
export function scoreBuysMatchEvidence(
  proposals: ProposalFixture[],
  evidence: Record<string, EvidenceEntry>,
  thresholds: VetoThresholds | undefined,
  regime: string
): ScoreResult {
  const riskOff = regime.startsWith("Crisis") || regime.startsWith("Risk-Off");
  // Normalize the evidence map keys the same way we normalize proposal symbols, so a fixture keyed
  // as `aapl`/mixed-case still matches (otherwise the contradiction checks silently skip and an
  // evidence-contradicting buy passes the offline eval).
  const evidenceByNorm = new Map(Object.entries(evidence).map(([k, v]) => [norm(k), v]));
  const contradictions: string[] = [];
  for (const p of proposals) {
    if (p.side !== "buy") continue;
    const ev = evidenceByNorm.get(norm(p.symbol));
    if (!ev) continue;
    if (thresholds?.fcfYieldFloorPct != null && ev.fcfYield != null && ev.fcfYield < thresholds.fcfYieldFloorPct) {
      contradictions.push(`${p.symbol}: fcfYield ${ev.fcfYield} < floor ${thresholds.fcfYieldFloorPct}`);
    } else if (thresholds?.debtToEquityCeiling != null && ev.debtToEquity != null && ev.debtToEquity > thresholds.debtToEquityCeiling) {
      contradictions.push(`${p.symbol}: debt/equity ${ev.debtToEquity} > ceiling ${thresholds.debtToEquityCeiling}`);
    } else if (riskOff && ev.score != null && ev.medianScore != null && ev.score < ev.medianScore) {
      contradictions.push(`${p.symbol}: below-median buy (${ev.score} < ${ev.medianScore}) in ${regime}`);
    }
  }
  return {
    pass: contradictions.length === 0,
    score: contradictions.length === 0 ? 1 : 0,
    detail: contradictions.length === 0
      ? "no buys contradict the structured evidence"
      : `evidence-contradicting buys: ${contradictions.join("; ")}`
  };
}

export interface StrategyEvalCase {
  id: string;
  step: "bull" | "bear";
  description: string;
  universe: string[];
  shortSellingEnabled: boolean;
  regime: string;
  modelOutput: { proposals: ProposalFixture[] };
  evidence: Record<string, EvidenceEntry>;
  vetoThresholds?: VetoThresholds;
}

export interface CaseScore {
  id: string;
  pass: boolean;
  score: number;
  scorers: Array<{ name: string; result: ScoreResult }>;
}

/** Run all three deterministic scorers on a case; the case passes only if all three pass. */
export function scoreStrategyCase(c: StrategyEvalCase): CaseScore {
  const scorers = [
    { name: "no-off-universe", result: scoreNoOffUniverse(c.modelOutput.proposals, c.universe) },
    { name: "shorts-have-stop", result: scoreShortsHaveStop(c.modelOutput.proposals, c.shortSellingEnabled) },
    { name: "buys-match-evidence", result: scoreBuysMatchEvidence(c.modelOutput.proposals, c.evidence, c.vetoThresholds, c.regime) }
  ];
  const pass = scorers.every((s) => s.result.pass);
  const score = scorers.reduce((sum, s) => sum + s.result.score, 0) / scorers.length;
  return { id: c.id, pass, score, scorers };
}
