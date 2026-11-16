import type { CongressAnalytics, CongressSignal } from "./web-sources";
export { WINDOW_PRESETS } from "@jaywedgeworth22/congress-trading-shared";

export type CongressScoreDirection = "BUY" | "SELL" | "NEUTRAL";

export interface CongressScoreComponents {
  conviction: number;
  consensus: number;
  memberSkill: number;
  flow: number;
  freshness: number;
  confidence: number;
  conflictContext: number;
}

export interface CongressScoreProvenance {
  computed: string[];
  sourced: string[];
  inferred: string[];
  missing: string[];
}

export interface CongressCompositeScore {
  score: number;
  signedScore: number;
  direction: CongressScoreDirection;
  /** 0-1 coverage confidence. Low confidence caps the score's effect. */
  confidence: number;
  components: CongressScoreComponents;
  provenance: CongressScoreProvenance;
  version: string;
  weights: CongressScoreComponents;
}

export interface CongressScoreInput {
  congress?: CongressSignal;
  congressAnalytics?: CongressAnalytics;
}

const DAY_MS = 86_400_000;

export const CONGRESS_SCORE_VERSION = "congress-score-v1-research";

export const CONGRESS_SCORE_WEIGHTS: CongressScoreComponents = {
  // Research weights (docs/congress-score-evaluation.md). memberSkill uses App A dual
  // performance with filing-date (copy-trade) preferred over trade-date timing.
  conviction: 0.25,
  consensus: 0.2,
  memberSkill: 0.2,
  flow: 0.15,
  freshness: 0.1,
  confidence: 0.1,
  // Context only until separately validated; do not let committee-sector overlap lift alpha score.
  conflictContext: 0
};

export function scoreCongressSignal(input?: CongressScoreInput, now: number = Date.now()): CongressCompositeScore {
  const analytics = input?.congressAnalytics;
  const congress = input?.congress;
  const direction = inferDirection(congress, analytics);
  const provenance: CongressScoreProvenance = { computed: [], sourced: [], inferred: [], missing: [] };

  const conviction = convictionComponent(direction, analytics, provenance);
  const consensus = consensusComponent(congress, analytics, provenance);
  const memberSkill = memberSkillComponent(analytics, provenance);
  const flow = flowComponent(direction, congress, analytics, provenance);
  const freshness = freshnessComponent(congress, now, provenance);
  const confidence = confidenceComponent(congress, analytics, provenance);
  const conflictContext = conflictComponent(analytics, provenance);

  const components: CongressScoreComponents = {
    conviction,
    consensus,
    memberSkill,
    flow,
    freshness,
    confidence,
    conflictContext
  };

  const rawScore = clamp(
    conviction * CONGRESS_SCORE_WEIGHTS.conviction +
    consensus * CONGRESS_SCORE_WEIGHTS.consensus +
    memberSkill * CONGRESS_SCORE_WEIGHTS.memberSkill +
    flow * CONGRESS_SCORE_WEIGHTS.flow +
    freshness * CONGRESS_SCORE_WEIGHTS.freshness +
    confidence * CONGRESS_SCORE_WEIGHTS.confidence +
    conflictContext * CONGRESS_SCORE_WEIGHTS.conflictContext
  );
  const cap = confidenceCap(confidence);
  if (direction !== "NEUTRAL" && rawScore > cap) provenance.computed.push("confidence cap applied");
  const score = direction === "NEUTRAL" ? 0 : round2(Math.min(rawScore, cap));
  const signedScore = direction === "SELL" ? -score : score;
  return {
    score,
    signedScore,
    direction,
    confidence: round4(confidence / 100),
    components,
    provenance,
    version: CONGRESS_SCORE_VERSION,
    weights: CONGRESS_SCORE_WEIGHTS
  };
}

/** Long-side outlier score used by Market Scan. SELL/neutral congressional composites return 0. */
export function congressLongScore(input?: CongressScoreInput, now: number = Date.now()): number {
  const scored = scoreCongressSignal(input, now);
  return scored.direction === "BUY" ? scored.score : 0;
}

function inferDirection(congress?: CongressSignal, analytics?: CongressAnalytics): CongressScoreDirection {
  if (analytics?.convictionDirection === "BUY" || analytics?.convictionDirection === "SELL") {
    return analytics.convictionDirection;
  }
  const votes =
    signedVote(analytics?.netSentiment, 0.05) +
    signedVote(analytics?.netFlowUsd, 1) +
    signedVote(congress?.netSignal, 0);
  if (votes > 0) return "BUY";
  if (votes < 0) return "SELL";
  return "NEUTRAL";
}

function convictionComponent(
  direction: CongressScoreDirection,
  analytics: CongressAnalytics | undefined,
  provenance: CongressScoreProvenance
): number {
  if (analytics?.convictionScore != null && Number.isFinite(analytics.convictionScore)) {
    provenance.sourced.push("congress.trade convictionScore");
    if (analytics.convictionFallback) provenance.inferred.push("conviction fallback/proxy inputs");
    return clamp(analytics.convictionScore);
  }
  if (direction !== "NEUTRAL") {
    provenance.inferred.push("directional conviction from flow/sentiment");
    return 55;
  }
  provenance.missing.push("convictionScore");
  return 0;
}

function consensusComponent(
  congress: CongressSignal | undefined,
  analytics: CongressAnalytics | undefined,
  provenance: CongressScoreProvenance
): number {
  const distinctMembers = Math.max(
    analytics?.memberCount ?? 0,
    analytics?.clusterMemberCount ?? 0,
    congress ? Math.max(congress.buyMembers?.length ?? 0, congress.sellMembers?.length ?? 0) : 0
  );
  if (distinctMembers <= 0) {
    provenance.missing.push("member breadth");
    return 0;
  }
  provenance.computed.push("member/cluster breadth");
  const clusterBase = analytics?.cluster ? 62 : 0;
  const memberBreadth = Math.min(100, 25 + distinctMembers * 12);
  return clamp(Math.max(clusterBase + Math.min(28, distinctMembers * 4), memberBreadth));
}

function memberSkillComponent(analytics: CongressAnalytics | undefined, provenance: CongressScoreProvenance): number {
  if (typeof analytics?.topMemberScore === "number" && Number.isFinite(analytics.topMemberScore)) {
    const src = analytics.topMemberScoreSource;
    if (src === "realized_skill_filing" || src === "realized_skill") {
      provenance.sourced.push("member realized skill (filing-date copy-trade)");
      if (typeof analytics.topMemberFilingAvgExcess === "number") {
        provenance.sourced.push(`filing avgExcess=${analytics.topMemberFilingAvgExcess}`);
      }
    } else if (src === "realized_skill_trade") {
      provenance.sourced.push("member realized skill (trade-date timing; filing unscored)");
    } else {
      provenance.inferred.push("member activity prominence fallback");
    }
    return clamp(analytics.topMemberScore);
  }
  provenance.missing.push("member skill");
  return 0;
}

function flowComponent(
  direction: CongressScoreDirection,
  congress: CongressSignal | undefined,
  analytics: CongressAnalytics | undefined,
  provenance: CongressScoreProvenance
): number {
  const netFlow = analytics?.netFlowUsd;
  if (typeof netFlow === "number" && Number.isFinite(netFlow) && netFlow !== 0) {
    if (!alignedWithDirection(netFlow, direction)) {
      provenance.inferred.push("estimated net flow contradicts direction");
      return 0;
    }
    provenance.computed.push("estimated net flow");
    return clamp(Math.min(100, 35 + Math.log10(Math.abs(netFlow) + 1) * 8));
  }
  if (typeof analytics?.netSentiment === "number" && Number.isFinite(analytics.netSentiment) && analytics.netSentiment !== 0) {
    if (!alignedWithDirection(analytics.netSentiment, direction)) {
      provenance.inferred.push("net sentiment contradicts direction");
      return 0;
    }
    provenance.computed.push("net sentiment");
    return clamp(50 + Math.abs(analytics.netSentiment) * 45);
  }
  if (typeof congress?.netSignal === "number" && congress.netSignal !== 0) {
    if (!alignedWithDirection(congress.netSignal, direction)) {
      provenance.inferred.push("raw congressional net signal contradicts direction");
      return 0;
    }
    provenance.computed.push("raw congressional net signal");
    return clamp(45 + Math.min(45, Math.abs(congress.netSignal) * 12));
  }
  provenance.missing.push("net flow");
  return 0;
}

function freshnessComponent(congress: CongressSignal | undefined, now: number, provenance: CongressScoreProvenance): number {
  const date = congress?.lastDisclosedAt;
  if (!date) {
    provenance.missing.push("disclosure recency");
    return 0;
  }
  const ageDays = Math.max(0, (now - Date.parse(date)) / DAY_MS);
  if (!Number.isFinite(ageDays)) {
    provenance.missing.push("valid disclosure recency");
    return 40;
  }
  provenance.computed.push("disclosure recency decay");
  return clamp(100 * Math.pow(0.5, ageDays / 30));
}

function confidenceComponent(
  congress: CongressSignal | undefined,
  analytics: CongressAnalytics | undefined,
  provenance: CongressScoreProvenance
): number {
  let score = 0;
  if (analytics?.convictionScore != null) score += 25;
  if ((analytics?.tradeCount ?? 0) >= 3 || (congress?.buyCount ?? 0) + (congress?.sellCount ?? 0) >= 3) score += 25;
  if ((analytics?.memberCount ?? 0) >= 2 || Math.max(congress?.buyMembers.length ?? 0, congress?.sellMembers.length ?? 0) >= 2) score += 20;
  if (typeof analytics?.topMemberScore === "number") score += 15;
  if (analytics?.cluster) score += 10;
  if (congress?.lastDisclosedAt) score += 5;
  if (score > 0) provenance.computed.push("data coverage confidence");
  else provenance.missing.push("confidence inputs");
  return clamp(score);
}

function conflictComponent(analytics: CongressAnalytics | undefined, provenance: CongressScoreProvenance): number {
  const count = analytics?.conflictCount ?? 0;
  if (!(count > 0)) return 0;
  provenance.sourced.push("committee-sector overlap context");
  return clamp(45 + Math.min(55, count * 10));
}

function confidenceCap(confidence: number): number {
  if (confidence <= 0) return 0;
  return clamp(30 + confidence * 0.7);
}

function alignedWithDirection(value: number, direction: CongressScoreDirection): boolean {
  if (direction === "NEUTRAL") return true;
  return direction === "BUY" ? value > 0 : value < 0;
}

function signedVote(value: unknown, deadband: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) <= deadband) return 0;
  return value > 0 ? 1 : -1;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
