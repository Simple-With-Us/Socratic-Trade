// App A (congress.trade) analytics overlay — the public "Trends" composite (ticker-leaderboard +
// cluster-buys + member-leaderboard) that App B can't derive from raw trades alone: dollar-weighted
// net flow, distinct-member counts, cluster buys (many members → same ticker), and member track-record.
//
// Refreshed on the scheduler (daily cadence) and persisted, then read synchronously by
// getSymbolWebSignals — mirroring the other web-source connectors (refresh → persist → no-network read).
// Default OFF (CONGRESS_ANALYTICS_ENABLED). Self-guarded; a 0-row pull keeps any prior dataset.

import { audit, getInternalSetting, setInternalSetting } from "../db";
import {
  congressAnalyticsEnabled,
  getCongressTradeClient
} from "../api-clients/congress";
import type {
  ConvictionTicker,
  MemberLeader,
  MemberPerformance
} from "@jaywedgeworth22/congress-trading-shared";
import { normalizeSymbol } from "../money";
import type { CongressAnalytics, WebSourceRefreshResult } from "./types";

const DATASET_KEY = "webSource:congressAnalytics:dataset";
const DEFAULT_TTL_MS = 24 * 60 * 60_000; // daily
const DEFAULT_WINDOW_DAYS = 90;
const TICKER_LIMIT = 1000;
const CLUSTER_LIMIT = 200;
const MEMBER_LIMIT = 500;
const CONFLICT_LIMIT = 1000; // fetch all conflicts in window (App A default=100; raise to catch all)
const MAX_SKILL_LOOKUPS = 200; // cap per-member performance calls per refresh

/**
 * App A dual performance payload (filingDate vs tradeDate legs). Not yet exported from
 * congress-trading-shared@v2.5.1 — local shape so skill ranking typechecks until the shared
 * package publishes MemberDualPerformance.
 */
type MemberPerformanceLeg = MemberPerformance & {
  avgAnnualizedExcess?: number | null;
};

type MemberDualPerformance = {
  filingDate?: MemberPerformanceLeg | null;
  tradeDate?: MemberPerformanceLeg | null;
  performance?: MemberPerformanceLeg | null;
};

export { congressAnalyticsEnabled };

interface CongressAnalyticsDataset {
  overlay: Record<string, CongressAnalytics>;
  fetchedAt: string;
  recordCount: number;
  windowDays: number;
}

function ttlMs(): number {
  const v = Number(process.env.CONGRESS_ANALYTICS_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

function windowDays(): number {
  const v = Number(process.env.CONGRESS_ANALYTICS_WINDOW_DAYS ?? DEFAULT_WINDOW_DAYS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_WINDOW_DAYS;
}

export function getCongressAnalyticsDataset(): CongressAnalyticsDataset | undefined {
  return getInternalSetting<CongressAnalyticsDataset>(DATASET_KEY);
}

export function isCongressAnalyticsRefreshDue(now: number = Date.now()): boolean {
  const ds = getCongressAnalyticsDataset();
  if (!ds?.fetchedAt) return true;
  return now - Date.parse(ds.fetchedAt) >= ttlMs();
}

/** Per-symbol analytics overlay for the requested symbols (sync; reads the cached dataset). */
export function getCongressAnalyticsOverlay(symbols: string[]): Record<string, CongressAnalytics> {
  const ds = getCongressAnalyticsDataset();
  if (!ds) return {};
  const out: Record<string, CongressAnalytics> = {};
  for (const raw of symbols) {
    const sym = normalizeSymbol(raw);
    if (sym && ds.overlay[sym]) out[sym] = ds.overlay[sym];
  }
  return out;
}

/**
 * Build a member → 0–100 weight from the leaderboard, rank-normalized over the chosen activity metric.
 * App A's member-leaderboard exposes ACTIVITY numerics (estVolumeUsd / tradeCount / netSentiment), not a
 * realized-performance/skill metric — so this is a prominence/conviction proxy (big dollar traders rank
 * high), NOT a track record. Upgrade to true skill-weighting when App A exposes per-member performance
 * (or App B aggregates /api/analytics/performance/:txId). Returns empty until filer_id resolves on App A
 * (member-leaderboard is empty while members are unresolved).
 */
export function buildMemberScores(members: MemberLeader[]): Map<string, number> {
  const PERF_FIELDS = ["estVolumeUsd", "tradeCount"]; // App A's real per-member magnitude fields
  const scored: Array<{ name: string; perf: number }> = [];
  for (const m of members) {
    const name = String(m.fullName || m.memberName || m.name || "").trim().toLowerCase();
    if (!name) continue;
    let perf: number | undefined;
    for (const f of PERF_FIELDS) {
      const v = (m as Record<string, unknown>)[f];
      if (typeof v === "number" && Number.isFinite(v)) {
        perf = v;
        break;
      }
    }
    if (perf !== undefined) scored.push({ name, perf });
  }
  const map = new Map<string, number>();
  if (scored.length === 0) return map;
  scored.sort((a, b) => b.perf - a.perf);
  scored.forEach((s, i) => map.set(s.name, Math.round(100 * (1 - i / Math.max(1, scored.length - 1)))));
  return map;
}

export type MemberSkillAnchor = "filing" | "trade";

/** Per-member skill detail from App A dual performance (filing preferred for trading). */
export interface MemberSkillDetail {
  /** 0–100 rank among the cohort on the preferred alpha metric. */
  score: number;
  anchor: MemberSkillAnchor;
  source: "realized_skill_filing" | "realized_skill_trade";
  avgExcess?: number | null;
  medianExcess?: number | null;
  winRate?: number | null;
  scoredCount?: number;
  avgAnnualizedExcess?: number | null;
  /** Opposite-anchor context (trade when primary is filing, and vice versa). */
  otherAnchor?: MemberSkillAnchor;
  otherAvgExcess?: number | null;
  otherWinRate?: number | null;
  otherScoredCount?: number;
}

function finiteNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function legAlpha(leg: MemberPerformanceLeg | null | undefined): number | undefined {
  if (!leg) return undefined;
  if (typeof leg.scoredCount !== "number" || leg.scoredCount <= 0) return undefined;
  // Prefer avgExcess (vs S&P); annualized is secondary ranking signal for filing leg only.
  return [leg.avgExcess, leg.medianExcess, leg.avgAnnualizedExcess, leg.avgReturn].find(
    (v): v is number => typeof v === "number" && Number.isFinite(v)
  );
}

/**
 * Pick the trading-relevant leg: **filingDate** (copy-trade since disclosure) first;
 * fall back to tradeDate (politician timing) when filing is unscored.
 */
export function preferMemberSkillLeg(dual: MemberDualPerformance | null | undefined): {
  leg: MemberPerformanceLeg;
  anchor: MemberSkillAnchor;
  other?: MemberPerformanceLeg;
  otherAnchor?: MemberSkillAnchor;
} | null {
  if (!dual) return null;
  const filing = dual.filingDate ?? undefined;
  const trade = dual.tradeDate ?? dual.performance ?? undefined;
  if (legAlpha(filing) !== undefined && filing) {
    return { leg: filing, anchor: "filing", other: trade, otherAnchor: trade ? "trade" : undefined };
  }
  if (legAlpha(trade) !== undefined && trade) {
    return { leg: trade, anchor: "trade", other: filing, otherAnchor: filing ? "filing" : undefined };
  }
  return null;
}

/**
 * Member SKILL details from App A's dual performance endpoint.
 * Rank-normalized 0–100 by preferred-leg alpha vs S&P (filing first). Keyed by filerId.
 */
export async function buildMemberSkillDetails(filerIds: string[]): Promise<Map<string, MemberSkillDetail>> {
  const map = new Map<string, MemberSkillDetail>();
  if (!congressAnalyticsEnabled() || filerIds.length === 0) return map;
  const distinct = Array.from(new Set(filerIds.map((id) => String(id || "").trim()).filter(Boolean))).slice(
    0,
    MAX_SKILL_LOOKUPS
  );
  if (distinct.length === 0) return map;

  const client = getCongressTradeClient();
  const perf = await Promise.all(
    distinct.map((id) =>
      client.getMemberPerformance(id).catch(() => null) as Promise<MemberDualPerformance | MemberPerformanceLeg | null>
    )
  );
  const scored: Array<{
    id: string;
    alpha: number;
    anchor: MemberSkillAnchor;
    leg: MemberPerformanceLeg;
    other?: MemberPerformanceLeg;
    otherAnchor?: MemberSkillAnchor;
  }> = [];
  distinct.forEach((id, i) => {
    const raw = perf[i];
    // Client may return dual {filingDate,tradeDate} or a single leg — normalize.
    const dual: MemberDualPerformance | null =
      raw && typeof raw === "object" && ("filingDate" in raw || "tradeDate" in raw || "performance" in raw)
        ? (raw as MemberDualPerformance)
        : raw
          ? { performance: raw as MemberPerformanceLeg }
          : null;
    const picked = preferMemberSkillLeg(dual);
    if (!picked) return;
    const alpha = legAlpha(picked.leg);
    if (alpha === undefined) return;
    scored.push({
      id,
      alpha,
      anchor: picked.anchor,
      leg: picked.leg,
      other: picked.other,
      otherAnchor: picked.otherAnchor
    });
  });
  if (scored.length === 0) return map;

  scored.sort((a, b) => b.alpha - a.alpha);
  scored.forEach((s, i) => {
    const rank = Math.round(100 * (1 - i / Math.max(1, scored.length - 1)));
    map.set(s.id, {
      score: rank,
      anchor: s.anchor,
      source: s.anchor === "filing" ? "realized_skill_filing" : "realized_skill_trade",
      avgExcess: s.leg.avgExcess ?? null,
      medianExcess: s.leg.medianExcess ?? null,
      winRate: s.leg.winRate ?? null,
      scoredCount: finiteNum(s.leg.scoredCount),
      avgAnnualizedExcess: s.leg.avgAnnualizedExcess ?? null,
      otherAnchor: s.otherAnchor,
      otherAvgExcess: s.other?.avgExcess ?? null,
      otherWinRate: s.other?.winRate ?? null,
      otherScoredCount: finiteNum(s.other?.scoredCount)
    });
  });
  return map;
}

/**
 * Member SKILL scores (0–100) only — thin wrapper over {@link buildMemberSkillDetails}.
 * Prefer filing-date alpha; falls back to trade-date. Empty until App A has scored performance.
 */
export async function buildMemberSkillScores(filerIds: string[]): Promise<Map<string, number>> {
  const details = await buildMemberSkillDetails(filerIds);
  const map = new Map<string, number>();
  for (const [id, d] of details) map.set(id, d.score);
  return map;
}

export async function refreshCongressAnalytics(now: number = Date.now(), force = false): Promise<WebSourceRefreshResult> {
  if (!congressAnalyticsEnabled()) {
    return { id: "congress-analytics", ok: true, recordCount: 0, sources: [], fetchedAt: "", skipped: true };
  }
  if (!force && !isCongressAnalyticsRefreshDue(now)) {
    const ds = getCongressAnalyticsDataset();
    return { id: "congress-analytics", ok: true, recordCount: ds?.recordCount ?? 0, sources: ["congress.trade"], fetchedAt: ds?.fetchedAt ?? "", skipped: true };
  }

  const window = `${windowDays()}d`;
  const client = getCongressTradeClient();
  const [leaders, clusters, members, convictions, conflicts] = await Promise.all([
    client.getTickerLeaderboard({ window, limit: TICKER_LIMIT }).catch(() => []),
    client.getClusterBuys({ window, limit: CLUSTER_LIMIT }).catch(() => []),
    client.getMemberLeaderboard({ window, limit: MEMBER_LIMIT }).catch(() => []),
    client.getConviction({ window, limit: TICKER_LIMIT }).catch(() => []),
    client.getConflicts({ window, limit: CONFLICT_LIMIT }).catch(() => [])
  ]);

  // Only count convictions with a real score — null means "thin signal" and is not usable data.
  const usableConvictions = convictions.filter((c: ConvictionTicker) => c.convictionScore !== null);
  // Guard only on the core endpoints: conviction/conflicts are supplemental and can return rows even
  // when leaderboard/clusters fail. Including them in the guard would cause a partial overlay
  // (conviction-only) to overwrite a prior complete dataset when the core endpoints are down.
  if (leaders.length === 0 && clusters.length === 0) {
    // App A cold / no recent data — keep any prior dataset rather than wiping to empty.
    const prior = getCongressAnalyticsDataset();
    audit("web_source_refresh", { id: "congress-analytics", ok: false, recordCount: 0, reason: "empty" });
    return {
      id: "congress-analytics",
      ok: false,
      recordCount: prior?.recordCount ?? 0,
      sources: ["congress.trade"],
      fetchedAt: prior?.fetchedAt ?? "",
      warning: "no analytics rows"
    };
  }

  const memberScores = buildMemberScores(members);
  // Real skill (filing-date copy-trade preferred) for cluster members; activity is fallback.
  const clusterFilerIds = clusters.flatMap((c) =>
    (Array.isArray(c.topMembers) ? c.topMembers : []).map((m) => String(m?.filerId ?? "")).filter(Boolean)
  );
  const skillDetails = await buildMemberSkillDetails(clusterFilerIds);

  // Conviction scores keyed by normalized ticker — null-score rows excluded (thin signal,
  // not usable data; including them could pull no-signal tickers into the scan via netSentiment).
  const convictionByTicker = new Map<string, ConvictionTicker>();
  for (const cv of usableConvictions) {
    const sym = normalizeSymbol(cv.ticker);
    if (sym) convictionByTicker.set(sym, cv);
  }

  // Conflict counts keyed by normalized ticker (one conflict trade = one flagged disclosure).
  const conflictsByTicker = new Map<string, number>();
  for (const cf of conflicts) {
    if (!cf.ticker) continue;
    const sym = normalizeSymbol(cf.ticker);
    if (sym) conflictsByTicker.set(sym, (conflictsByTicker.get(sym) ?? 0) + 1);
  }

  const overlay: Record<string, CongressAnalytics> = {};
  for (const t of leaders) {
    const sym = normalizeSymbol(t.ticker);
    if (!sym) continue;
    const entry: CongressAnalytics = {};
    if (typeof t.estNetFlowUsd === "number") entry.netFlowUsd = t.estNetFlowUsd;
    if (typeof t.estVolumeUsd === "number") entry.estVolumeUsd = t.estVolumeUsd;
    if (typeof t.tradeCount === "number") entry.tradeCount = t.tradeCount;
    if (typeof t.buyCount === "number") entry.buyCount = t.buyCount;
    if (typeof t.sellCount === "number") entry.sellCount = t.sellCount;
    if (typeof t.memberCount === "number") entry.memberCount = t.memberCount;
    if (typeof t.netSentiment === "number") entry.netSentiment = t.netSentiment;
    const cv = convictionByTicker.get(sym);
    if (cv) {
      entry.convictionScore = cv.convictionScore;
      entry.convictionDirection = cv.direction;
      entry.convictionFallback = cv.fallback;
    }
    const cc = conflictsByTicker.get(sym);
    if (cc) entry.conflictCount = cc;
    overlay[sym] = entry;
  }
  // Tickers in conviction but not leaderboard (e.g. SELL-only tickers that rank below TICKER_LIMIT
  // on volume but still have a strong directional signal).
  for (const [sym, cv] of convictionByTicker) {
    if (overlay[sym]) continue; // already populated from leaders
    const entry: CongressAnalytics = {
      convictionScore: cv.convictionScore,
      convictionDirection: cv.direction,
      convictionFallback: cv.fallback
    };
    if (typeof cv.memberCount === "number") entry.memberCount = cv.memberCount;
    if (typeof cv.tradeCount === "number") entry.tradeCount = cv.tradeCount;
    if (typeof cv.netSentiment === "number") entry.netSentiment = cv.netSentiment;
    if (typeof cv.estNetFlowUsd === "number") entry.netFlowUsd = cv.estNetFlowUsd;
    const cc = conflictsByTicker.get(sym);
    if (cc) entry.conflictCount = cc;
    overlay[sym] = entry;
  }
  // Tickers in conflicts but absent from leaderboard and conviction — conflict-only overlay entry.
  for (const [sym, cc] of conflictsByTicker) {
    if (overlay[sym]) continue;
    overlay[sym] = { conflictCount: cc };
  }
  for (const c of clusters) {
    const sym = normalizeSymbol(typeof c.ticker === "string" ? c.ticker : "");
    if (!sym) continue;
    const entry = (overlay[sym] ??= {});
    entry.cluster = true;
    if (typeof c.memberCount === "number") entry.clusterMemberCount = c.memberCount;
    const topMembers = Array.isArray(c.topMembers) ? c.topMembers : [];
    let best = 0;
    let bestSource: CongressAnalytics["topMemberScoreSource"] | undefined;
    let bestDetail: MemberSkillDetail | undefined;
    let bestFilerId: string | undefined;
    for (const m of topMembers) {
      const filerId = String(m?.filerId ?? "").trim();
      const name = String((m?.fullName || m?.memberName || m?.name) ?? "").trim().toLowerCase();
      // Prefer real skill (filing-date copy-trade first); fall back to activity prominence.
      const detail = filerId ? skillDetails.get(filerId) : undefined;
      const skill = detail?.score;
      const activity = name ? memberScores.get(name) : undefined;
      const s = skill ?? activity;
      if (typeof s === "number" && s > best) {
        best = s;
        bestSource = detail ? detail.source : "activity_prominence";
        bestDetail = detail;
        bestFilerId = filerId || undefined;
      }
    }
    if (best > 0) {
      entry.topMemberScore = best;
      entry.topMemberScoreSource = bestSource;
      if (bestFilerId) entry.topMemberFilerId = bestFilerId;
      if (bestDetail) {
        if (bestDetail.anchor === "filing") {
          entry.topMemberFilingAvgExcess = bestDetail.avgExcess ?? null;
          entry.topMemberFilingWinRate = bestDetail.winRate ?? null;
          entry.topMemberFilingScoredCount = bestDetail.scoredCount;
          entry.topMemberFilingAvgAnnualizedExcess = bestDetail.avgAnnualizedExcess ?? null;
          entry.topMemberTradeAvgExcess = bestDetail.otherAvgExcess ?? null;
          entry.topMemberTradeWinRate = bestDetail.otherWinRate ?? null;
          entry.topMemberTradeScoredCount = bestDetail.otherScoredCount;
        } else {
          entry.topMemberTradeAvgExcess = bestDetail.avgExcess ?? null;
          entry.topMemberTradeWinRate = bestDetail.winRate ?? null;
          entry.topMemberTradeScoredCount = bestDetail.scoredCount;
          entry.topMemberFilingAvgExcess = bestDetail.otherAvgExcess ?? null;
          entry.topMemberFilingWinRate = bestDetail.otherWinRate ?? null;
          entry.topMemberFilingScoredCount = bestDetail.otherScoredCount;
        }
      }
    }
  }

  const recordCount = Object.keys(overlay).length;
  const dataset: CongressAnalyticsDataset = {
    overlay,
    fetchedAt: new Date(now).toISOString(),
    recordCount,
    windowDays: windowDays()
  };
  setInternalSetting(DATASET_KEY, dataset);
  audit("web_source_refresh", {
    id: "congress-analytics",
    ok: true,
    recordCount,
    tickers: leaders.length,
    clusters: clusters.length,
    members: members.length,
    convictions: convictions.length,
    conflicts: conflicts.length
  });
  return { id: "congress-analytics", ok: true, recordCount, sources: ["congress.trade"], fetchedAt: dataset.fetchedAt };
}
