import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Root cause (2026-07-08): Robinhood's review_equity_order pre-flight already announces a
// guaranteed-reject via `order_checks.alertType` (EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR /
// EQUITY_SUB_DOLLAR_SHARE_BASED_ORDER), but reviewEquityOrder() only ever read a top-level
// `raw.alerts` array (which Robinhood doesn't populate for this case) and never `order_checks`.
beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rh-order-checks-${randomUUID()}.db`)}`;
});

describe("Robinhood order_checks pre-flight parsing", () => {
  it("parses order_checks as an array and surfaces the dollar-based minimum alertType", async () => {
    const { parseRobinhoodOrderChecks } = await import("../src/lib/robinhood");
    const { alertTypes, messages } = parseRobinhoodOrderChecks({
      order_checks: [
        { alertType: "EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR", message: "Dollar-based orders must be at least $1." }
      ]
    });
    expect(alertTypes).toEqual(["EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR"]);
    expect(messages).toEqual(["Dollar-based orders must be at least $1."]);
  });

  it("parses order_checks as a single object and surfaces the sub-dollar share-based alertType", async () => {
    const { parseRobinhoodOrderChecks } = await import("../src/lib/robinhood");
    const { alertTypes } = parseRobinhoodOrderChecks({
      order_checks: { alert_type: "EQUITY_SUB_DOLLAR_SHARE_BASED_ORDER" }
    });
    expect(alertTypes).toEqual(["EQUITY_SUB_DOLLAR_SHARE_BASED_ORDER"]);
  });

  it("returns empty arrays when order_checks is absent or the payload is empty", async () => {
    const { parseRobinhoodOrderChecks } = await import("../src/lib/robinhood");
    expect(parseRobinhoodOrderChecks({})).toEqual({ alertTypes: [], messages: [] });
    expect(parseRobinhoodOrderChecks(undefined)).toEqual({ alertTypes: [], messages: [] });
  });

  it("reviewEquityOrder surfaces a structured preflightBlock for a sub-$1 dollar-based order", async () => {
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            structuredContent: {
              data: {
                estimated_cost: 0.23,
                order_checks: [
                  {
                    alertType: "EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR",
                    message: "Dollar-based orders must be at least $1."
                  }
                ]
              },
              guide: "ok"
            }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { getRobinhoodGateway } = await import("../src/lib/robinhood");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-a", { accessToken: "test-token", tokenType: "Bearer" });

    const review = await getRobinhoodGateway("user-a").reviewEquityOrder({
      accountNumber: "RH-ACCOUNT",
      symbol: "AAPL",
      side: "sell",
      type: "market",
      dollarAmount: 0.23,
      timeInForce: "gfd",
      marketHours: "regular_hours"
    });

    expect(review.estimatedNotional).toBe(0.23);
    expect(review.preflightBlock?.alertTypes).toEqual(["EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR"]);
    expect(review.preflightBlock?.message).toContain("at least $1");
  });

  it("reviewEquityOrder surfaces a structured preflightBlock for a sub-dollar share-based order", async () => {
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            structuredContent: {
              data: {
                estimated_cost: 0.2,
                // Single-object envelope (not an array) — parsing must tolerate both shapes.
                order_checks: {
                  alert_type: "EQUITY_SUB_DOLLAR_SHARE_BASED_ORDER",
                  description: "Fractional orders must be at least $1."
                }
              },
              guide: "ok"
            }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { getRobinhoodGateway } = await import("../src/lib/robinhood");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-b", { accessToken: "test-token", tokenType: "Bearer" });

    const review = await getRobinhoodGateway("user-b").reviewEquityOrder({
      accountNumber: "RH-ACCOUNT",
      symbol: "AAPL",
      side: "sell",
      type: "market",
      quantity: 0.001,
      timeInForce: "gfd",
      marketHours: "regular_hours"
    });

    expect(review.preflightBlock?.alertTypes).toEqual(["EQUITY_SUB_DOLLAR_SHARE_BASED_ORDER"]);
    expect(review.preflightBlock?.message).toContain("at least $1");
  });

  it("reviewEquityOrder does not set preflightBlock for a normal, well-sized order", async () => {
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { structuredContent: { data: { estimated_cost: 500 }, guide: "ok" } }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { getRobinhoodGateway } = await import("../src/lib/robinhood");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-c", { accessToken: "test-token", tokenType: "Bearer" });

    const review = await getRobinhoodGateway("user-c").reviewEquityOrder({
      accountNumber: "RH-ACCOUNT",
      symbol: "AAPL",
      side: "sell",
      type: "market",
      dollarAmount: 500,
      timeInForce: "gfd",
      marketHours: "regular_hours"
    });

    expect(review.estimatedNotional).toBe(500);
    expect(review.preflightBlock).toBeUndefined();
  });
});
