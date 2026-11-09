import { getDb } from "../src/lib/db";

// Regression tests for the per-user Robinhood broker-token tenant-isolation fix.
//
// PR #42 made the Robinhood OAuth token per-user (keyed by userId), but two read-only
// enrichment paths fetched broker data with NO userId, so the fetchers fell through to a
// `DEV_USER_ID` ('local') default and silently used the operator's real broker credentials
// for every user. These tests pin the fix: the access token is resolved from the caller's
// own userId, a user with no token never resolves another user's ('local') token, and a
// shared/background pass with no user in scope fails closed instead of borrowing 'local'.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MCP_URL = "https://mcp.example.test/trading";
// USER_A is the dev/operator identity ("local") whose token must never leak to another tenant.
const USER_A = "local";
const USER_B = "u_other_tenant";
const TOKEN_A = "tok-user-a-local";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rh-iso-${randomUUID()}.db`)}`;
});

interface FetchRecord {
  url: string;
  authorization: string | null;
}

/**
 * Stub global fetch as the Robinhood MCP endpoint. User A's token is the ONLY credential that
 * unlocks A's private broker data; any other (or absent) Authorization header gets an empty
 * result, never another user's data. Non-MCP URLs (Yahoo/Stooq in the OHLC cascade) 404 fast.
 */
function installMcpFetchMock(): { records: FetchRecord[] } {
  const records: FetchRecord[] = [];
  const aData = {
    data: {
      historicals: [
        { begins_at: "2026-06-18", open_price: "111", high_price: "112", low_price: "110", close_price: "111.11", volume: "1000" },
        { begins_at: "2026-06-19", open_price: "112", high_price: "113", low_price: "111", close_price: "222.22", volume: "2000" }
      ],
      results: [
        { symbol: "AAAA", pe_ratio: "13.5", high_52_weeks: "300", low_52_weeks: "100", average_volume: "5000", sector: "Tech", industry: "Software" }
      ]
    }
  };
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const authorization = new Headers(init?.headers).get("authorization");
    records.push({ url: u, authorization });
    if (u === MCP_URL) {
      const payload = authorization === `Bearer ${TOKEN_A}` ? aData : { data: {} };
      const result = {
        jsonrpc: "2.0",
        id: "1",
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] }
      };
      return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
    }
    // Yahoo/Stooq and anything else: no data (4xx is not retried by politeFetch).
    return new Response("", { status: 404 });
  });
  return { records };
}

async function seedUserAToken(): Promise<void> {
  const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
  setMcpOAuthTokens(USER_A, { accessToken: TOKEN_A, tokenType: "Bearer" });
}

describe("robinhood tenant isolation — historicals", () => {
  it("resolves the CALLER's per-user token; user B never resolves user A's ('local') token", async () => {
    vi.stubEnv("ROBINHOOD_ADAPTER", "mcp");
    vi.stubEnv("ROBINHOOD_MCP_URL", MCP_URL);
    const { records } = installMcpFetchMock();
    await seedUserAToken();
    const { fetchRobinhoodHistoricals } = await import("../src/lib/robinhood");

    // User B has no stored token → no broker data, and crucially never borrows A's token.
    const barsB = await fetchRobinhoodHistoricals("AAAA", { userId: USER_B });
    expect(barsB).toBeNull();
    expect(records.some((r) => r.authorization === `Bearer ${TOKEN_A}`)).toBe(false);

    // Positive control: user A gets their own data via their own token (threading works).
    const barsA = await fetchRobinhoodHistoricals("AAAA", { userId: USER_A });
    expect(barsA?.map((b) => b.close)).toEqual([111.11, 222.22]);
    expect(records.some((r) => r.url === MCP_URL && r.authorization === `Bearer ${TOKEN_A}`)).toBe(true);
  });
});

describe("robinhood tenant isolation — fundamentals", () => {
  it("resolves the CALLER's per-user token; user B never resolves user A's ('local') token", async () => {
    vi.stubEnv("ROBINHOOD_ADAPTER", "mcp");
    vi.stubEnv("ROBINHOOD_MCP_URL", MCP_URL);
    const { records } = installMcpFetchMock();
    await seedUserAToken();
    const { fetchRobinhoodFundamentals } = await import("../src/lib/robinhood");

    const fundB = await fetchRobinhoodFundamentals(["AAAA"], USER_B);
    expect(fundB).toEqual({});
    expect(records.some((r) => r.authorization === `Bearer ${TOKEN_A}`)).toBe(false);

    const fundA = await fetchRobinhoodFundamentals(["AAAA"], USER_A);
    expect(fundA.AAAA).toBeTruthy();
    expect(records.some((r) => r.url === MCP_URL && r.authorization === `Bearer ${TOKEN_A}`)).toBe(true);
  });
});

describe("robinhood tenant isolation — RobinhoodEnrichmentProvider", () => {
  it("threads the request userId; user B's enrichment never resolves user A's token", async () => {
    vi.stubEnv("ROBINHOOD_ADAPTER", "mcp");
    vi.stubEnv("ROBINHOOD_MCP_URL", MCP_URL);
    const { records } = installMcpFetchMock();
    await seedUserAToken();
    const { RobinhoodEnrichmentProvider } = await import("../src/lib/data-providers");

    const enrichB = await new RobinhoodEnrichmentProvider(USER_B).enrich(["AAAA"]);
    expect(enrichB).toEqual({ AAAA: {} });
    expect(records.some((r) => r.authorization === `Bearer ${TOKEN_A}`)).toBe(false);

    // Positive control: user A's provider resolves A's fundamentals via A's own token.
    const enrichA = await new RobinhoodEnrichmentProvider(USER_A).enrich(["AAAA"]);
    expect(enrichA.AAAA?.peRatio).toBe(13.5);
  });

  it("fails closed with NO user in scope — never borrows 'local' for a shared/background pass", async () => {
    vi.stubEnv("ROBINHOOD_ADAPTER", "mcp");
    vi.stubEnv("ROBINHOOD_MCP_URL", MCP_URL);
    const { records } = installMcpFetchMock();
    await seedUserAToken();
    const { RobinhoodEnrichmentProvider } = await import("../src/lib/data-providers");

    const enrich = await new RobinhoodEnrichmentProvider(undefined).enrich(["AAAA"]);
    expect(enrich).toEqual({ AAAA: {} });
    // Fail-closed: no broker call whatsoever (would otherwise have used 'local').
    expect(records.some((r) => r.url === MCP_URL)).toBe(false);
  });
});

describe("robinhood tenant isolation — fetchDailyOHLC cascade", () => {
  it("omits the private Robinhood tier when no user is in scope (shared/background scan)", async () => {
    vi.stubEnv("ROBINHOOD_ADAPTER", "mcp");
    vi.stubEnv("ROBINHOOD_MCP_URL", MCP_URL);
    const { records } = installMcpFetchMock();
    await seedUserAToken();
    const { fetchDailyOHLC, clearHistoryCache } = await import("../src/lib/history");
    const { getDb } = await import("../src/lib/db");

    clearHistoryCache();
    try { getDb().exec("DELETE FROM imported_price_eod"); } catch {}
    const barsShared = await fetchDailyOHLC("AAAA", Date.now()); // no userId → background/shared
    expect(barsShared).toBeNull(); // RH skipped; public tiers mocked to 404 → no data
    expect(records.some((r) => r.url === MCP_URL)).toBe(false); // broker never touched

    // Positive control: a real user in scope DOES use their OWN token for the private tier.
    clearHistoryCache();
    try { getDb().exec("DELETE FROM imported_price_eod"); } catch {}
    const barsUserA = await fetchDailyOHLC("AAAA", Date.now(), USER_A);
    expect(barsUserA?.map((b) => b.close)).toEqual([111.11, 222.22]);
    expect(records.some((r) => r.url === MCP_URL && r.authorization === `Bearer ${TOKEN_A}`)).toBe(true);
  });
});

describe("robinhood oauth callback — session binding", () => {
  it("rejects completing a state that belongs to a different session", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    const { buildMcpAuthorizationUrl, completeMcpOAuthCallback, getStoredMcpOAuthTokens } = await import("../src/lib/mcp-oauth");

    const urlStr = await buildMcpAuthorizationUrl("user-a");
    const state = new URL(urlStr).searchParams.get("state")!;

    // user-b's session tries to complete user-a's flow → rejected before any token exchange.
    await expect(completeMcpOAuthCallback({ code: "auth-code", state, expectedUserId: "user-b" })).rejects.toThrow(
      /does not belong to the current session/
    );
    // No token bound for either party; the consumed state can't be replayed.
    expect(getStoredMcpOAuthTokens("user-a")).toBeUndefined();
    expect(getStoredMcpOAuthTokens("user-b")).toBeUndefined();
  });

  it("allows completing when the session matches the initiating user (mismatch guard is a no-op)", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ access_token: "fresh-token", token_type: "Bearer", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const { buildMcpAuthorizationUrl, completeMcpOAuthCallback, getStoredMcpOAuthTokens } = await import("../src/lib/mcp-oauth");

    const urlStr = await buildMcpAuthorizationUrl("user-a");
    const state = new URL(urlStr).searchParams.get("state")!;

    const tokens = await completeMcpOAuthCallback({ code: "auth-code", state, expectedUserId: "user-a" });
    expect(tokens.accessToken).toBe("fresh-token");
    // Token bound under the initiating user only.
    expect(getStoredMcpOAuthTokens("user-a")?.accessToken).toBe("fresh-token");
    expect(getStoredMcpOAuthTokens("user-b")).toBeUndefined();
  });

  it("allows completing a provider callback with no app session by using the stored state owner", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ access_token: "state-owned-token", token_type: "Bearer", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const { buildMcpAuthorizationUrl, completeMcpOAuthCallback, getStoredMcpOAuthTokens } = await import("../src/lib/mcp-oauth");

    const urlStr = await buildMcpAuthorizationUrl("user-a");
    const state = new URL(urlStr).searchParams.get("state")!;

    const tokens = await completeMcpOAuthCallback({ code: "auth-code", state });
    expect(tokens.accessToken).toBe("state-owned-token");
    expect(getStoredMcpOAuthTokens("user-a")?.accessToken).toBe("state-owned-token");
    expect(getStoredMcpOAuthTokens("user-b")).toBeUndefined();
  });
});
