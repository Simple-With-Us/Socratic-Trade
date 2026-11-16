import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMemberScores,
  buildMemberSkillScores,
  getCongressAnalyticsOverlay,
  refreshCongressAnalytics
} from "../src/lib/web-sources/congress-analytics";
import { getSymbolWebSignals } from "../src/lib/web-sources";
import { congressAnalyticsScore, outlierInterestScore } from "../src/lib/market";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-congress-analytics-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  delete process.env.CONGRESS_ANALYTICS_ENABLED;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubAnalyticsFetch(p: {
  tickers?: unknown[];
  clusters?: unknown[];
  members?: unknown[];
  convictions?: unknown[];
  conflicts?: unknown[];
  perf?: Record<string, unknown>; // per-member performance keyed by filerId (for /member/:id/performance)
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("ticker-leaderboard")) return new Response(JSON.stringify({ tickers: p.tickers ?? [] }), { status: 200 });
      if (u.includes("cluster-buys")) return new Response(JSON.stringify({ clusters: p.clusters ?? [] }), { status: 200 });
      if (u.includes("member-leaderboard")) return new Response(JSON.stringify({ members: p.members ?? [] }), { status: 200 });
      if (u.includes("analytics/conviction")) return new Response(JSON.stringify({ tickers: p.convictions ?? [] }), { status: 200 });
      if (u.includes("analytics/conflicts")) return new Response(JSON.stringify({ conflicts: p.conflicts ?? [] }), { status: 200 });
      const perfMatch = u.match(/\/member\/([^/]+)\/performance/);
      if (perfMatch) {
        const id = decodeURIComponent(perfMatch[1]);
        const leg = p.perf?.[id] ?? null;
        if (!leg) return new Response(JSON.stringify({ performance: null }), { status: 200 });
        // Dual envelope: allow explicit dual shape or wrap a single leg as filing+trade.
        if (typeof leg === "object" && leg && ("filingDate" in (leg as object) || "tradeDate" in (leg as object))) {
          return new Response(JSON.stringify(leg), { status: 200 });
        }
        return new Response(
          JSON.stringify({ filerId: id, filingDate: leg, tradeDate: leg, performance: leg }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    })
  );
}

describe("congress analytics overlay", () => {
  it("is inert when disabled (no fetch, skipped refresh)", async () => {
    process.env.CONGRESS_ANALYTICS_ENABLED = "off";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await refreshCongressAnalytics(Date.now());
    expect(res.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getCongressAnalyticsOverlay(["ZZZZ"])).toEqual({});
  });

  it("refreshes from App A and builds a per-symbol overlay (incl. cluster + member quality)", async () => {
    process.env.CONGRESS_ANALYTICS_ENABLED = "on";
    stubAnalyticsFetch({
      tickers: [
        { ticker: "aapl", tradeCount: 5, buyCount: 4, sellCount: 1, memberCount: 3, estNetFlowUsd: 250000, estVolumeUsd: 400000, netSentiment: 0.6 }
      ],
      clusters: [{ ticker: "AAPL", memberCount: 3, topMembers: [{ fullName: "Jane Doe" }] }],
      members: [
        { fullName: "Jane Doe", estVolumeUsd: 500000 },
        { fullName: "John Roe", estVolumeUsd: 100000 }
      ]
    });
    const res = await refreshCongressAnalytics(Date.now(), true);
    expect(res.ok).toBe(true);
    const overlay = getCongressAnalyticsOverlay(["AAPL"]);
    expect(overlay.AAPL).toMatchObject({ netFlowUsd: 250000, memberCount: 3, cluster: true, clusterMemberCount: 3 });
    expect(overlay.AAPL.topMemberScore).toBe(100); // Jane Doe is the top-ranked member
    expect(overlay.AAPL.topMemberScoreSource).toBe("activity_prominence");
  });

  it("keeps the prior dataset on an empty pull (App A cold)", async () => {
    process.env.CONGRESS_ANALYTICS_ENABLED = "on";
    stubAnalyticsFetch({ tickers: [], clusters: [], members: [] });
    const res = await refreshCongressAnalytics(Date.now(), true);
    expect(res.ok).toBe(false);
    expect(res.warning).toContain("no analytics");
  });

  it("uses real per-member skill (alpha vs S&P) over the activity proxy when scored performance exists", async () => {
    process.env.CONGRESS_ANALYTICS_ENABLED = "on";
    stubAnalyticsFetch({
      tickers: [{ ticker: "nvda", tradeCount: 3, estNetFlowUsd: 100000 }],
      // Two cluster members: the higher-alpha filer should win even if the other has more activity.
      clusters: [
        {
          ticker: "NVDA",
          memberCount: 2,
          topMembers: [
            { filerId: "house-x-low-alpha", fullName: "Big Volume" },
            { filerId: "house-y-high-alpha", fullName: "Sharp Trader" }
          ]
        }
      ],
      members: [
        { filerId: "house-x-low-alpha", fullName: "Big Volume", estVolumeUsd: 9_000_000 },
        { filerId: "house-y-high-alpha", fullName: "Sharp Trader", estVolumeUsd: 1_000 }
      ],
      perf: {
        "house-x-low-alpha": { scoredCount: 20, avgExcess: 0.01 },
        "house-y-high-alpha": { scoredCount: 20, avgExcess: 0.25 } // best alpha → rank-normalized to 100
      }
    });
    const res = await refreshCongressAnalytics(Date.now(), true);
    expect(res.ok).toBe(true);
    // topMemberScore is the max skill score across the cluster's members — the high-alpha filer at 100.
    expect(getCongressAnalyticsOverlay(["NVDA"]).NVDA.topMemberScore).toBe(100);
    expect(getCongressAnalyticsOverlay(["NVDA"]).NVDA.topMemberScoreSource).toBe("realized_skill_filing");
    expect(getCongressAnalyticsOverlay(["NVDA"]).NVDA.topMemberFilingAvgExcess).toBe(0.25);
    expect(getCongressAnalyticsOverlay(["NVDA"]).NVDA.topMemberFilingScoredCount).toBe(20);
  });

  it("prefers filing-date alpha over trade-date when both legs exist", async () => {
    process.env.CONGRESS_ANALYTICS_ENABLED = "on";
    stubAnalyticsFetch({
      tickers: [{ ticker: "META", tradeCount: 2, estNetFlowUsd: 50_000 }],
      clusters: [
        {
          ticker: "META",
          memberCount: 1,
          topMembers: [{ filerId: "filer-dual", fullName: "Dual Leg" }]
        }
      ],
      members: [{ filerId: "filer-dual", fullName: "Dual Leg", estVolumeUsd: 1 }],
      perf: {
        "filer-dual": {
          filingDate: { scoredCount: 10, avgExcess: 0.05, winRate: 0.7 },
          tradeDate: { scoredCount: 12, avgExcess: 0.3, winRate: 0.9 },
          performance: { scoredCount: 12, avgExcess: 0.3, winRate: 0.9 }
        }
      }
    });
    await refreshCongressAnalytics(Date.now(), true);
    const row = getCongressAnalyticsOverlay(["META"]).META;
    expect(row.topMemberScoreSource).toBe("realized_skill_filing");
    expect(row.topMemberFilingAvgExcess).toBe(0.05);
    expect(row.topMemberTradeAvgExcess).toBe(0.3);
  });

  it("labels raw conviction as an input instead of an uncapped standalone score", async () => {
    process.env.CONGRESS_ANALYTICS_ENABLED = "on";
    stubAnalyticsFetch({
      tickers: [{ ticker: "MSFT", tradeCount: 3, memberCount: 1 }],
      clusters: [],
      members: [],
      convictions: [{ ticker: "MSFT", convictionScore: 100, direction: "BUY", fallback: true, tradeCount: 3, memberCount: 1 }]
    });
    await refreshCongressAnalytics(Date.now(), true);

    const bulletins = getSymbolWebSignals(["MSFT"]).MSFT?.bulletins ?? [];
    expect(bulletins.some((b) => b.startsWith("Congress.Trade advisory composite: BUY "))).toBe(true);
    expect(bulletins).toContain("Congress.Trade conviction input/pre-cap: BUY 100/100 (proxy inputs)");
    expect(bulletins).not.toContain("Congress.Trade directional score: BUY 100/100");
  });
});

describe("buildMemberScores", () => {
  it("rank-normalizes App A's activity metric (estVolumeUsd) to 0–100, keyed by fullName", () => {
    const m = buildMemberScores([
      { fullName: "A", estVolumeUsd: 50 },
      { fullName: "B", estVolumeUsd: 10 },
      { fullName: "C", estVolumeUsd: 30 }
    ]);
    expect(m.get("a")).toBe(100);
    expect(m.get("b")).toBe(0);
    expect(m.get("c")).toBe(50);
  });

  it("is empty when no recognized activity field is present (inert until filer_id resolves on App A)", () => {
    expect(buildMemberScores([{ fullName: "A", buyCount: 5 } as any]).size).toBe(0);
  });
});

describe("buildMemberSkillScores", () => {
  beforeEach(() => {
    process.env.CONGRESS_ANALYTICS_ENABLED = "on";
  });

  it("rank-normalizes realized alpha (avgExcess) to 0–100, keyed by filerId", async () => {
    stubAnalyticsFetch({
      perf: {
        a: { scoredCount: 10, avgExcess: 0.2 },
        b: { scoredCount: 10, avgExcess: 0.05 },
        c: { scoredCount: 10, avgExcess: 0.125 }
      }
    });
    const m = await buildMemberSkillScores(["a", "b", "c"]);
    expect(m.get("a")).toBe(100);
    expect(m.get("b")).toBe(0);
    expect(m.get("c")).toBe(50);
  });

  it("skips members with no scored trades (scoredCount 0 / null perf) and dedupes input", async () => {
    stubAnalyticsFetch({
      perf: {
        scored: { scoredCount: 5, avgExcess: 0.1 },
        unscored: { scoredCount: 0, avgExcess: null }
      }
    });
    const m = await buildMemberSkillScores(["scored", "scored", "unscored", "missing", ""]);
    expect(m.has("unscored")).toBe(false);
    expect(m.has("missing")).toBe(false);
    expect(m.get("scored")).toBe(100); // sole scored member → top of its (size-1) ranking
    expect(m.size).toBe(1);
  });

  it("falls back to medianExcess then avgReturn when avgExcess is absent", async () => {
    stubAnalyticsFetch({
      perf: {
        med: { scoredCount: 3, medianExcess: 0.3 },
        ret: { scoredCount: 3, avgReturn: 0.1 }
      }
    });
    const m = await buildMemberSkillScores(["med", "ret"]);
    expect(m.get("med")).toBe(100); // 0.3 > 0.1
    expect(m.get("ret")).toBe(0);
  });

  it("is empty (no fetch) when analytics is disabled", async () => {
    process.env.CONGRESS_ANALYTICS_ENABLED = "off";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect((await buildMemberSkillScores(["a"])).size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("congressAnalyticsScore + outlierInterestScore boost", () => {
  it("scores net-buying analytics above 0 and net-selling / neutral at 0", () => {
    expect(congressAnalyticsScore({ netFlowUsd: 1_000_000, cluster: true, memberCount: 4, topMemberScore: 80 })).toBeGreaterThan(50);
    expect(congressAnalyticsScore({ netFlowUsd: -1000, netSentiment: -1 })).toBe(0);
    expect(congressAnalyticsScore(undefined)).toBe(0);
  });

  it("lifts outlierInterestScore via the analytics overlay alone (no scraped signal needed)", () => {
    const score = outlierInterestScore({
      bulletins: [],
      congressAnalytics: { netFlowUsd: 5_000_000, cluster: true, memberCount: 5, tradeCount: 5, convictionScore: 85, convictionDirection: "BUY", topMemberScore: 90 }
    });
    expect(score).toBeGreaterThan(60);
  });

  it("does not promote weak or bearish analytics as below-cutoff outliers", () => {
    expect(outlierInterestScore({
      bulletins: [],
      congressAnalytics: { convictionScore: 100, convictionDirection: "BUY", convictionFallback: true }
    })).toBe(0);
    expect(outlierInterestScore({
      bulletins: [],
      congressAnalytics: { netFlowUsd: -500_000, convictionScore: 90, convictionDirection: "SELL", memberCount: 3 }
    })).toBe(0);
  });
});
