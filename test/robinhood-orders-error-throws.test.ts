/**
 * (1) [HIGH] Robinhood getEquityOrders must THROW on a broker-side error / malformed response —
 * never coalesce it to an empty list. A masked-empty result feeds the placement reconcile
 * (reconcilePlacementError / flagStalePlacingIntents), which reads [] as "the broker has no such
 * order" and would mark a genuinely-placed/filled order not_placed, drop its durable 'placing'
 * intent, never book the fill, and let the next run DUPLICATE the position. After the fix:
 *   - a tool-level `isError: true` MCP result       → throws (surfaced by unpackMcpToolResult)
 *   - a success payload with no orders/results array → throws (extractRobinhoodOrderCollection)
 *   - a genuine empty collection ({ results: [] })   → returns [] (authoritative empty)
 *   - a populated collection                         → returns the mapped orders
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

function mcpResult(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

async function makeRobinhoodGateway(userId: string) {
  const { getRobinhoodGateway } = await import("../src/lib/robinhood");
  const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
  setMcpOAuthTokens(userId, { accessToken: "test-token", tokenType: "Bearer" });
  return getRobinhoodGateway(userId);
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rh-orders-error-${randomUUID()}.db`)}`;
});

describe("Robinhood getEquityOrders error-vs-empty discrimination", () => {
  it("THROWS on a tool-level isError result (so reconcile classifies uncertain, not not_placed)", async () => {
    // A 2xx JSON-RPC success whose tool result reports isError: true — the exact case
    // callRobinhoodMcpMethod does NOT throw on (it only throws on JSON-RPC error / HTTP non-2xx).
    vi.stubGlobal("fetch", async () =>
      mcpResult({ content: [{ type: "text", text: "Rate limited — try again later." }], isError: true })
    );
    const gateway = await makeRobinhoodGateway(`rh-iserror-${randomUUID()}`);
    await expect(gateway.getEquityOrders("RH-ACCOUNT")).rejects.toThrow(/error/i);
  });

  it("THROWS on a success payload with no recognizable orders/results collection", async () => {
    vi.stubGlobal("fetch", async () =>
      mcpResult({ structuredContent: { data: { message: "unexpected shape, no orders here" }, guide: "ok" } })
    );
    const gateway = await makeRobinhoodGateway(`rh-malformed-${randomUUID()}`);
    await expect(gateway.getEquityOrders("RH-ACCOUNT")).rejects.toThrow(/unrecognized shape|orders\/results/i);
  });

  it("returns [] for a genuinely empty account (authoritative empty list)", async () => {
    vi.stubGlobal("fetch", async () => mcpResult({ structuredContent: { data: { results: [] }, guide: "ok" } }));
    const gateway = await makeRobinhoodGateway(`rh-empty-${randomUUID()}`);
    await expect(gateway.getEquityOrders("RH-ACCOUNT")).resolves.toEqual([]);
  });

  it("returns mapped orders for a populated list", async () => {
    vi.stubGlobal("fetch", async () =>
      mcpResult({
        structuredContent: {
          data: {
            results: [
              {
                id: "ord-1",
                symbol: "AAPL",
                side: "buy",
                type: "market",
                state: "filled",
                ref_id: "my-client-key",
                cumulative_quantity: 3,
                average_price: 200.25,
                // Default listings keep terminal orders inside the since-window.
                created_at: new Date().toISOString()
              }
            ]
          },
          guide: "ok"
        }
      })
    );
    const gateway = await makeRobinhoodGateway(`rh-populated-${randomUUID()}`);
    const orders = await gateway.getEquityOrders("RH-ACCOUNT");
    expect(orders).toHaveLength(1);
    expect(orders[0].id).toBe("ord-1");
    expect(orders[0].state).toBe("filled");
    expect(orders[0].clientOrderId).toBe("my-client-key");
  });
});
