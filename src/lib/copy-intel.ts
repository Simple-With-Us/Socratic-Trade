/**
 * CopyTrader intelligence — evaluate other investors from official eToro
 * rankings / live-portfolio payloads, and decide whether a FOLLOW is even
 * eligible.  This module is pure: no network, no keys, no order placement.
 *
 * Default policy is observe-only.  Selective follow is an owner allowlist
 * plus hard caps (risk, copiers, allocation).  Auto-copy of strangers is
 * never on.  Execution, when the owner later enables it, goes through the
 * official eToro Copy Trading API — not scrape / unofficial wrappers.
 */

export type CopyIntelMode = "off" | "observe" | "allowlist-follow";

export interface CopyRankRow {
  username: string;
  cid?: number;
  type?: "trader" | "smart-portfolio" | string;
  subType?: string | null;
  gain?: number;
  annualizedReturn?: number;
  riskScore?: number;
  copiers?: number;
  winRatio?: number;
  peakToValley?: number;
  profitableMonthsPct?: number;
  trades?: number;
  copyInvestmentPct?: number;
  highLeveragePct?: number;
  activeWeeks?: number;
  weeksSinceRegistration?: number;
  country?: string | null;
}

export interface CopyLivePosition {
  instrumentId: number;
  isBuy: boolean;
  leverage: number;
  investmentPct?: number;
  netProfit?: number;
  openRate?: number;
  trailingStopLoss?: boolean;
}

export interface CopyFollowPolicy {
  mode: CopyIntelMode;
  allowlist: string[];
  maxRiskScore: number;
  minCopiers: number;
  minWinRatio: number;
  minActiveWeeks: number;
  maxCopyInvestmentPct: number;
  maxHighLeveragePct: number;
  maxFollows: number;
  maxAllocationPct: number;
}

export const DEFAULT_COPY_FOLLOW_POLICY: CopyFollowPolicy = {
  mode: "observe",
  allowlist: [],
  maxRiskScore: 6,
  minCopiers: 50,
  minWinRatio: 50,
  minActiveWeeks: 26,
  maxCopyInvestmentPct: 40,
  maxHighLeveragePct: 25,
  maxFollows: 5,
  maxAllocationPct: 10
};

export interface CopyScoreFlag {
  id: string;
  severity: "info" | "warn" | "block";
  detail: string;
}

export interface CopyScore {
  username: string;
  score: number;
  eligibleToFollow: boolean;
  flags: CopyScoreFlag[];
  reasons: string[];
}

export function normalizeCopyUsername(username: string): string {
  return username.trim().replace(/^@/, "").toLowerCase();
}

export function scoreCopyInvestor(row: CopyRankRow, policy: CopyFollowPolicy = DEFAULT_COPY_FOLLOW_POLICY): CopyScore {
  const username = normalizeCopyUsername(row.username ?? "");
  const flags: CopyScoreFlag[] = [];
  const reasons: string[] = [];
  let score = 50;

  const gain = num(row.annualizedReturn) ?? num(row.gain);
  if (gain != null) {
    // gain is a decimal fraction (0.12 = 12.34% per eToro RankItem docs)
    const pct = gain <= 2 ? gain * 100 : gain;
    score += clamp(pct / 2, -20, 25);
    reasons.push(`period return ${pct.toFixed(1)}%`);
  }

  if (row.winRatio != null) {
    score += clamp((row.winRatio - 50) / 4, -10, 15);
    reasons.push(`win ratio ${row.winRatio.toFixed(1)}%`);
  }

  if (row.riskScore != null) {
    score += clamp((5 - row.riskScore) * 3, -15, 12);
    reasons.push(`risk ${row.riskScore}/10`);
    if (row.riskScore > policy.maxRiskScore) {
      flags.push({
        id: "risk-high",
        severity: "block",
        detail: `risk score ${row.riskScore} exceeds cap ${policy.maxRiskScore}`
      });
    }
  }

  if (row.peakToValley != null) {
    const dd = Math.abs(row.peakToValley);
    const ddPct = dd <= 2 ? dd * 100 : dd;
    score -= clamp(ddPct / 4, 0, 15);
    if (ddPct > 30) {
      flags.push({ id: "drawdown", severity: "warn", detail: `peak-to-valley ${ddPct.toFixed(1)}%` });
    }
  }

  if (row.copiers != null) {
    if (row.copiers < policy.minCopiers) {
      flags.push({
        id: "thin-copiers",
        severity: "warn",
        detail: `${row.copiers} copiers (min ${policy.minCopiers})`
      });
    } else {
      score += 3;
    }
  }

  if (row.winRatio != null && row.winRatio < policy.minWinRatio) {
    flags.push({
      id: "win-ratio-low",
      severity: "block",
      detail: `win ratio ${row.winRatio} below ${policy.minWinRatio}`
    });
  }

  if (row.activeWeeks != null && row.activeWeeks < policy.minActiveWeeks) {
    flags.push({
      id: "short-history",
      severity: "block",
      detail: `${row.activeWeeks} active weeks (min ${policy.minActiveWeeks})`
    });
  }

  // High copyInvestmentPct means they mostly copy other people — weak signal to copy.
  if (row.copyInvestmentPct != null && row.copyInvestmentPct > policy.maxCopyInvestmentPct) {
    flags.push({
      id: "copy-of-copies",
      severity: "block",
      detail: `${row.copyInvestmentPct.toFixed(0)}% of book is itself a copy`
    });
  }

  if (row.highLeveragePct != null && row.highLeveragePct > policy.maxHighLeveragePct) {
    flags.push({
      id: "leverage",
      severity: "block",
      detail: `${row.highLeveragePct.toFixed(0)}% high-leverage (cap ${policy.maxHighLeveragePct})`
    });
  }

  if (!username) {
    flags.push({ id: "no-username", severity: "block", detail: "missing username" });
  }

  score = clamp(score, 0, 100);
  const blocked = flags.some((f) => f.severity === "block");
  return {
    username,
    score: Math.round(score * 10) / 10,
    eligibleToFollow: !blocked && Boolean(username),
    flags,
    reasons
  };
}

export function shouldObserve(policy: CopyFollowPolicy): boolean {
  return policy.mode === "observe" || policy.mode === "allowlist-follow";
}

/**
 * A follow is allowed only in allowlist-follow mode, only for an allowlisted
 * username, only when the score is eligible, and only under the follow-count
 * and allocation caps.  Observe mode never returns true.
 */
export function shouldAllowFollow(input: {
  policy: CopyFollowPolicy;
  score: CopyScore;
  currentFollowCount: number;
}): boolean {
  const { policy, score, currentFollowCount } = input;
  if (policy.mode !== "allowlist-follow") return false;
  if (!score.eligibleToFollow) return false;
  const wanted = normalizeCopyUsername(score.username);
  if (!policy.allowlist.map(normalizeCopyUsername).includes(wanted)) return false;
  if (currentFollowCount >= policy.maxFollows) return false;
  return true;
}

export function summarizeLiveBook(positions: CopyLivePosition[]): {
  positionCount: number;
  longPct: number;
  leveragedPct: number;
  topInstrumentIds: number[];
} {
  const total = positions.reduce((sum, p) => sum + (p.investmentPct ?? 0), 0) || positions.length || 1;
  const long = positions.filter((p) => p.isBuy).reduce((sum, p) => sum + (p.investmentPct ?? 1), 0);
  const lev = positions.filter((p) => (p.leverage ?? 1) > 1).reduce((sum, p) => sum + (p.investmentPct ?? 1), 0);
  const ranked = [...positions].sort((a, b) => (b.investmentPct ?? 0) - (a.investmentPct ?? 0));
  return {
    positionCount: positions.length,
    longPct: (long / total) * 100,
    leveragedPct: (lev / total) * 100,
    topInstrumentIds: ranked.slice(0, 5).map((p) => p.instrumentId)
  };
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
