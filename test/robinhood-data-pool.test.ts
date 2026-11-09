// Robinhood-acquired PUBLIC market data (bars + fundamentals) is consent-pooled like every other
// user-keyed source: a user who opted into the reciprocal data pool contributes their RH-fetched
// bars/fundamentals to the pool (and reads other consenters' contributions); a non-consenting user
// keeps their pulls private and never reads the pool. The RH OAuth token stays strictly per-user —
// only the resulting public data is shared, never account-private info.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MCP_URL = "https://mcp.example.test/trading";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rh-pool-${randomUUID()}.db`)}`;
  vi.stubEnv("ROBINHOOD_ADAPTER", "mcp");
  vi.stubEnv("ROBINHOOD_MCP_URL", MCP_URL);
});

/** Stub the RH MCP endpoint to return public bars + fundamentals for any authed call; count calls. */
function installMcpMock(): { mcpCalls: () => number } {
  let calls = 0;
  const data = {
    data: {
      historicals: [
        { begins_at: "2026-06-18", open_price: "111", high_price: "112", low_price: "110", close_price: "111.11", volume: "1000" },
        { begins_at: "2026-06-19", open_price: "112", high_price: "113", low_price: "111", close_price: "222.22", volume: "2000" }
      ],
      results: [{ symbol: "AAAA", pe_ratio: "13.5", high_52_weeks: "300", low_52_weeks: "100", average_volume: "5000", sector: "Tech", industry: "Software" }]
    }
  };
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const auth = new Headers(init?.headers).get("authorization");
    if (u === MCP_URL) {
      calls++;
      const payload = auth?.startsWith("Bearer ") ? data : { data: {} };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("", { status: 404 }); // Yahoo/Stooq/etc. → no data
  });
  return { mcpCalls: () => calls };
}

async function seedUser(userId: string, token: string, consent: boolean): Promise<void> {
  const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
  const { setDataPoolConsent } = await import("../src/lib/db");
  setMcpOAuthTokens(userId, { accessToken: token, tokenType: "Bearer" });
  setDataPoolConsent(userId, consent);
}

describe("robinhood fundamentals → consent pool", () => {
  it("a consenting user's RH fundamentals are pooled and served to another consenting user", async () => {
    const { mcpCalls } = installMcpMock();
    await seedUser("u_a", "tok-a", true);
    await seedUser("u_b", "tok-b", true);
    const { RobinhoodEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    const a = await new RobinhoodEnrichmentProvider("u_a").enrich(["AAAA"]);
    expect(a.AAAA?.peRatio).toBe(13.5);
    expect(mcpCalls()).toBe(1); // user A fetched

    // User B (also consenting) reads A's contribution from the pool — no second broker call.
    const b = await new RobinhoodEnrichmentProvider("u_b").enrich(["AAAA"]);
    expect(b.AAAA?.peRatio).toBe(13.5);
    expect(mcpCalls()).toBe(1); // still 1 — B was served from the pool
  });

  it("a non-consenting user keeps RH fundamentals private — they never reach the pool", async () => {
    const { mcpCalls } = installMcpMock();
    await seedUser("u_c", "tok-c", false); // NOT consenting
    await seedUser("u_b", "tok-b", true);
    const { RobinhoodEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    await new RobinhoodEnrichmentProvider("u_c").enrich(["AAAA"]); // fetch → private cache
    expect(mcpCalls()).toBe(1);

    // A consenting user does NOT see the non-consenter's private data → must fetch its own.
    const b = await new RobinhoodEnrichmentProvider("u_b").enrich(["AAAA"]);
    expect(b.AAAA?.peRatio).toBe(13.5);
    expect(mcpCalls()).toBe(2); // B had to fetch — C's pull stayed private
  });
});

describe("robinhood historicals → consent pool", () => {
  it("a consenting user's RH bars are pooled and served to another consenting user", async () => {
    const { mcpCalls } = installMcpMock();
    await seedUser("u_a", "tok-a", true);
    await seedUser("u_b", "tok-b", true);
    const { fetchDailyOHLC, clearHistoryCache } = await import("../src/lib/history");
    clearHistoryCache();

    const now = Date.now();
    const barsA = await fetchDailyOHLC("AAAA", now, "u_a");
    expect(barsA?.map((bar) => bar.close)).toEqual([111.11, 222.22]);
    expect(mcpCalls()).toBe(1); // user A fetched RH bars

    const barsB = await fetchDailyOHLC("AAAA", now + 1000, "u_b");
    expect(barsB?.map((bar) => bar.close)).toEqual([111.11, 222.22]);
    expect(mcpCalls()).toBe(1); // B read the pooled bars — no second broker call
  });
});
