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
  getAppAClusterBuys,
  getAppAConflicts,
  getAppAConviction,
  getAppAMemberLeaderboard,
  getAppAMemberPerformance,
  getAppATickerLeaderboard,
  type AppAConvictionTicker,
  type AppAMemberRow
} from "../congress-trade-client";
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
export function buildMemberScores(members: AppAMemberRow[]): Map<string, number> {
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

/**
 * Member SKILL scores (0–100) from App A's per-member performance endpoint, rank-normalized by realized
 * alpha vs the S&P (`avgExcess`, falling back to `medianExcess` then `avgReturn`). Only members with
 * `scoredCount > 0` are ranked — App A returns nulls until a member has scored trades (which needs prices
 * filled in). Returns a Map keyed by **filerId** (stable), distinct from the name-keyed activity proxy.
 * Empty until App A has scored performance; callers fall back to `buildMemberScores` (activity prominence).
 */
export async function buildMemberSkillScores(filerIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const distinct = Array.from(new Set(filerIds.map((id) => String(id || "").trim()).filter(Boolean))).slice(
    0,
    MAX_SKILL_LOOKUPS
  );
  if (distinct.length === 0) return map;

  const perf = await Promise.all(distinct.map((id) => getAppAMemberPerformance(id).catch(() => null)));
  const scored: Array<{ id: string; alpha: number }> = [];
  distinct.forEach((id, i) => {
    const p = perf[i];
    if (!p || typeof p.scoredCount !== "number" || p.scoredCount <= 0) return;
    const alpha = [p.avgExcess, p.medianExcess, p.avgReturn].find(
      (v): v is number => typeof v === "number" && Number.isFinite(v)
    );
    if (typeof alpha === "number") scored.push({ id, alpha });
  });
  if (scored.length === 0) return map;

  scored.sort((a, b) => b.alpha - a.alpha);
  scored.forEach((s, i) => map.set(s.id, Math.round(100 * (1 - i / Math.max(1, scored.length - 1)))));
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
  const [leaders, clusters, members, convictions, conflicts] = await Promise.all([
    getAppATickerLeaderboard({ window, limit: TICKER_LIMIT }),
    getAppAClusterBuys({ window, limit: CLUSTER_LIMIT }),
    getAppAMemberLeaderboard({ window, limit: MEMBER_LIMIT }),
    getAppAConviction({ window, limit: TICKER_LIMIT }),
    getAppAConflicts({ window, limit: CONFLICT_LIMIT })
  ]);

  // Only count convictions with a real score — null means "thin signal" and is not usable data.
  const usableConvictions = convictions.filter((c) => c.convictionScore !== null);
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
  // Real skill (alpha vs S&P, keyed by filerId) for the members surfaced in clusters; the name-keyed
  // activity proxy below is the fallback until App A has scored per-member performance.
  const clusterFilerIds = clusters.flatMap((c) =>
    (Array.isArray(c.topMembers) ? c.topMembers : []).map((m) => String(m?.filerId ?? "")).filter(Boolean)
  );
  const skillScores = await buildMemberSkillScores(clusterFilerIds);

  // Conviction scores keyed by normalized ticker — null-score rows excluded (thin signal,
  // not usable data; including them could pull no-signal tickers into the scan via netSentiment).
  const convictionByTicker = new Map<string, AppAConvictionTicker>();
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
    for (const m of topMembers) {
      const filerId = String(m?.filerId ?? "").trim();
      const name = String((m?.fullName || m?.memberName || m?.name) ?? "").trim().toLowerCase();
      // Prefer real skill (alpha vs S&P, by filerId); fall back to activity prominence (by name).
      const skill = filerId ? skillScores.get(filerId) : undefined;
      const activity = name ? memberScores.get(name) : undefined;
      const s = skill ?? activity;
      if (typeof s === "number" && s > best) {
        best = s;
        bestSource = skill !== undefined ? "realized_skill" : "activity_prominence";
      }
    }
    if (best > 0) {
      entry.topMemberScore = best;
      entry.topMemberScoreSource = bestSource;
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
