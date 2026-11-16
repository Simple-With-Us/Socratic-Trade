import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rh-pnl-xcheck-${randomUUID()}.db`)}`;
});

const NOW = "2026-07-01T00:00:00.000Z";

// Seed a realized $100 gain on a Robinhood (live) account: buy 10 @ $100, sell 10 @ $110.
async function seedLiveRealizedGain(
  accountNumber: string,
  userId: string,
  opts: { symbol?: string; entryAt?: string; exitAt?: string; idPrefix?: string } = {}
) {
  const { insertFillEvent } = await import("../src/lib/db");
  const symbol = opts.symbol ?? "AAPL";
  const idPrefix = opts.idPrefix ?? symbol.toLowerCase();
  insertFillEvent({
    userId,
    accountNumber,
    source: "live",
    symbol,
    side: "buy",
    quantity: 10,
    price: 100,
    notional: 1000,
    status: "filled",
    brokerOrderId: `${idPrefix}-open-1`,
    filledAt: opts.entryAt ?? "2026-04-01T15:00:00.000Z"
  });
  insertFillEvent({
    userId,
    accountNumber,
    source: "live",
    symbol,
    side: "sell",
    quantity: 10,
    price: 110,
    notional: 1100,
    status: "filled",
    brokerOrderId: `${idPrefix}-close-1`,
    filledAt: opts.exitAt ?? "2026-04-10T15:00:00.000Z"
  });
}

function stubRealizedPnlFetch(realizedPnl: unknown) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ method: request.method, params: request.params });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { structuredContent: { data: realizedPnl, guide: "ok" } }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });
  return calls;
}

describe("crossCheckRealizedPnl", () => {
  it("reports within-tolerance when Robinhood's realized P&L matches the app's live figure", async () => {
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    await seedLiveRealizedGain("RH-ACCOUNT", "user-a");
    // Robinhood reports $102 realized (its own bucketing/timezone rules) vs the app's $100 — ~2%.
    const calls = stubRealizedPnlFetch({ total_realized_pnl: "102.00" });

    const { crossCheckRealizedPnl } = await import("../src/lib/robinhood-pnl-crosscheck");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-a", { accessToken: "test-token", tokenType: "Bearer" });

    const result = await crossCheckRealizedPnl("user-a", "RH-ACCOUNT", { now: NOW });

    expect(result.appRealizedPnl).toBeCloseTo(100);
    expect(result.robinhoodRealizedPnl).toBeCloseTo(102);
    expect(result.discrepancyAbs).toBeCloseTo(2);
    expect(result.discrepancyPct).toBeCloseTo((2 / 102) * 100);
    expect(result.withinTolerance).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("tools/call");
    expect(calls[0].params).toMatchObject({
      name: "get_realized_pnl",
      arguments: { account_number: "RH-ACCOUNT", span: "3month" }
    });
  });

  it("flags out-of-tolerance when the two figures diverge widely", async () => {
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    await seedLiveRealizedGain("RH-ACCOUNT", "user-a");
    stubRealizedPnlFetch({ total_realized_pnl: "500.00" });

    const { crossCheckRealizedPnl } = await import("../src/lib/robinhood-pnl-crosscheck");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-a", { accessToken: "test-token", tokenType: "Bearer" });

    const result = await crossCheckRealizedPnl("user-a", "RH-ACCOUNT", { now: NOW });

    expect(result.appRealizedPnl).toBeCloseTo(100);
    expect(result.robinhoodRealizedPnl).toBeCloseTo(500);
    expect(result.discrepancyAbs).toBeCloseTo(400);
    expect(result.withinTolerance).toBe(false);
  });

  it("sums only equity per-bucket realized-gain rows when Robinhood returns mixed asset buckets", async () => {
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    await seedLiveRealizedGain("RH-ACCOUNT", "user-a");
    stubRealizedPnlFetch({
      total_realized_pnl: "1000.00",
      results: [
        { asset_class: "equity", realized_gain: "60.00" },
        { asset_class: "stock", realized_gain: "40.00" },
        { asset_class: "option", realized_gain: "900.00" }
      ]
    });

    const { crossCheckRealizedPnl } = await import("../src/lib/robinhood-pnl-crosscheck");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-a", { accessToken: "test-token", tokenType: "Bearer" });

    const result = await crossCheckRealizedPnl("user-a", "RH-ACCOUNT", { now: NOW });

    expect(result.robinhoodRealizedPnl).toBeCloseTo(100);
    expect(result.discrepancyAbs).toBeCloseTo(0);
    expect(result.withinTolerance).toBe(true);
  });

  it("honors an explicit span option", async () => {
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    await seedLiveRealizedGain("RH-ACCOUNT", "user-a");
    const calls = stubRealizedPnlFetch({ total_realized_pnl: "100.00" });

    const { crossCheckRealizedPnl } = await import("../src/lib/robinhood-pnl-crosscheck");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-a", { accessToken: "test-token", tokenType: "Bearer" });

    await crossCheckRealizedPnl("user-a", "RH-ACCOUNT", { span: "year", now: NOW });

    expect(calls[0].params).toMatchObject({ arguments: { span: "year" } });
  });

  it("filters the app realized P&L to the requested span while keeping pre-span opening lots for basis", async () => {
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    await seedLiveRealizedGain("RH-ACCOUNT", "user-a", {
      symbol: "AAPL",
      entryAt: "2026-01-15T15:00:00.000Z",
      exitAt: "2026-02-01T15:00:00.000Z",
      idPrefix: "old"
    });
    await seedLiveRealizedGain("RH-ACCOUNT", "user-a", {
      symbol: "MSFT",
      entryAt: "2026-01-15T15:00:00.000Z",
      exitAt: "2026-06-01T15:00:00.000Z",
      idPrefix: "window"
    });
    stubRealizedPnlFetch({ total_realized_pnl: "100.00" });

    const { crossCheckRealizedPnl } = await import("../src/lib/robinhood-pnl-crosscheck");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-a", { accessToken: "test-token", tokenType: "Bearer" });

    const result = await crossCheckRealizedPnl("user-a", "RH-ACCOUNT", { span: "3month", now: NOW });

    expect(result.appRealizedPnl).toBeCloseTo(100);
    expect(result.robinhoodRealizedPnl).toBeCloseTo(100);
    expect(result.withinTolerance).toBe(true);
  });

  it("returns undefined Robinhood/discrepancy fields when Robinhood is not connected", async () => {
    // No token stored for this user → callRobinhoodMcpTool throws "not connected"; crosscheck swallows it.
    await seedLiveRealizedGain("RH-ACCOUNT", "user-nope");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { crossCheckRealizedPnl } = await import("../src/lib/robinhood-pnl-crosscheck");

    const result = await crossCheckRealizedPnl("user-nope", "RH-ACCOUNT", { now: NOW });

    expect(result.appRealizedPnl).toBeCloseTo(100);
    expect(result.robinhoodRealizedPnl).toBeUndefined();
    expect(result.discrepancyAbs).toBeUndefined();
    expect(result.discrepancyPct).toBeUndefined();
    expect(result.withinTolerance).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns undefined Robinhood fields when the MCP call errors", async () => {
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    await seedLiveRealizedGain("RH-ACCOUNT", "user-a");
    vi.stubGlobal("fetch", async () => {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32000, message: "not authorized" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const { crossCheckRealizedPnl } = await import("../src/lib/robinhood-pnl-crosscheck");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-a", { accessToken: "test-token", tokenType: "Bearer" });

    const result = await crossCheckRealizedPnl("user-a", "RH-ACCOUNT", { now: NOW });

    expect(result.appRealizedPnl).toBeCloseTo(100);
    expect(result.robinhoodRealizedPnl).toBeUndefined();
    expect(result.withinTolerance).toBeUndefined();
  });
});
