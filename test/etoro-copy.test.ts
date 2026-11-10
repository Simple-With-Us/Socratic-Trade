import { describe, expect, it, vi } from "vitest";
import {
  fetchEToroLivePortfolio,
  fetchEToroRankings,
  livePortfolioUrl,
  mapEToroRankItem,
  rankingsUrl
} from "../src/lib/etoro-copy";

const creds = { apiKey: "test-api", userKey: "test-user" };

describe("etoro-copy official client", () => {
  it("builds the documented rankings and live-portfolio URLs", () => {
    expect(rankingsUrl({ period: "OneYearAgo", popularInvestor: true, sort: "-copiers" })).toBe(
      "https://public-api.etoro.com/api/v2/portfolios/rankings?period=OneYearAgo&sort=-copiers&popularInvestor=true"
    );
    expect(livePortfolioUrl("AlphaPilot")).toBe(
      "https://public-api.etoro.com/api/v1/user-info/people/AlphaPilot/portfolio/live"
    );
  });

  it("maps ranking rows onto CopyRankRow without inventing fields", () => {
    const mapped = mapEToroRankItem({
      username: "AlphaPilot",
      cid: 9,
      gain: 0.2,
      riskScore: 3,
      copiers: 120,
      extra: "drop-me"
    });
    expect(mapped).toMatchObject({ username: "AlphaPilot", cid: 9, gain: 0.2, riskScore: 3, copiers: 120 });
    expect(mapped).not.toHaveProperty("extra");
  });

  it("fetches rankings through the official path and sends the 3-header auth pair", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toContain("/api/v2/portfolios/rankings");
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("test-api");
      expect(headers["x-user-key"]).toBe("test-user");
      expect(headers["x-request-id"]).toMatch(/[0-9a-f-]{36}/i);
      return new Response(JSON.stringify({ results: [{ username: "AlphaPilot", gain: 0.1, riskScore: 4 }] }), {
        status: 200
      });
    });
    const rows = await fetchEToroRankings(creds, { period: "OneYearAgo" }, fetchImpl as unknown as typeof fetch);
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe("AlphaPilot");
  });

  it("maps a live public portfolio into positions", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          positions: [
            { instrumentId: 17, isBuy: true, leverage: 1, investmentPct: 40, netProfit: 0.05 },
            { instrumentId: 18, isBuy: false, leverage: 1, investmentPct: 20 }
          ]
        }),
        { status: 200 }
      )
    );
    const positions = await fetchEToroLivePortfolio(creds, "AlphaPilot", fetchImpl as unknown as typeof fetch);
    expect(positions).toHaveLength(2);
    expect(positions[0]).toMatchObject({ instrumentId: 17, isBuy: true, investmentPct: 40 });
  });
});
