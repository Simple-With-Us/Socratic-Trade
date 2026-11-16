import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const restPlace = vi.hoisted(() => ({
  createCalls: 0,
  lastCreate: null as Record<string, unknown> | null,
  sendRequest: null as null | ((path: string) => Promise<Record<string, unknown>>),
  getOrder: null as null | ((orderId: string) => Promise<Record<string, unknown>>)
}));

// Mock Alpaca Trade API SDK client
vi.mock("@alpacahq/alpaca-trade-api", () => {
  class MockAlpaca {
      async getAccount() {
        return { account_number: "MOCK_REST_ACC_1", portfolio_value: "10000", buying_power: "5000", equity: "8000", cash: "2000" };
      }
      async getPositions() {
        return [{ symbol: "AAPL", qty: "10", avg_entry_price: "150", market_value: "1500" }];
      }
      async getOrders() {
        return [{ id: "order_rest_1", symbol: "AAPL", side: "buy", type: "market", status: "filled", qty: "10" }];
      }
      async createOrder(opts: any) {
        restPlace.createCalls += 1;
        restPlace.lastCreate = opts;
        return { id: "order_rest_new", status: "accepted", qty: opts.qty, filled_qty: "0", filled_avg_price: null };
      }
      async cancelOrder() {}
      async getOrder(orderId: string) {
        if (restPlace.getOrder) return restPlace.getOrder(orderId);
        const err: { message: string; response: { status: number } } = Object.assign(new Error("not found"), {
          response: { status: 404 }
        });
        throw err;
      }
      async sendRequest(path: string) {
        if (restPlace.sendRequest) return restPlace.sendRequest(path);
        const err: { message: string; response: { status: number } } = Object.assign(new Error("not found"), {
          response: { status: 404 }
        });
        throw err;
      }
  }
  return { Alpaca: MockAlpaca, default: MockAlpaca };
});
beforeEach(async () => {
  vi.useRealTimers();
  vi.doUnmock("../src/lib/inflight-deadline");
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  restPlace.createCalls = 0;
  restPlace.lastCreate = null;
  restPlace.sendRequest = null;
  restPlace.getOrder = null;
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-alpaca-mcp-${randomUUID()}.db`)}`;

  const { upsertConnectedAccount } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: "acc-mcp-test",
    userId: "local",
    broker: "alpaca-mcp",
    environment: "paper",
    baseUrl: "http://localhost:8000/sse",
    apiKey: "PK_TEST",
    apiSecret: "secret",
    isActive: true,
    label: "Alpaca Paper"
  });
});

describe("Alpaca MCP gateway adapter", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes getAccounts() to get_account_info tool and parses result", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || "{}")) });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ account_number: "MCP_ACC_1" })
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");
    const accounts = await gateway.getAccounts();

    expect(accounts).toEqual([
      {
        accountNumber: "MCP_ACC_1",
        label: "Alpaca Paper",
        agenticAllowed: true,
        capabilities: {
          equityTrading: true,
          shortSelling: false,
          optionsTrading: false,
          futuresTrading: false,
          cryptoTrading: false,
          marginEnabled: false,
          accountType: "brokerage",
          extendedHours: true,
          fractional: true,
          marketHours: ["regular_hours", "extended_hours"],
          minOrderNotional: undefined,
          minShareQuantity: undefined,
          nativeBrackets: true,
          optionsOrders: false,
          orderTypes: ["market", "limit", "stop_market", "stop_limit"],
          overnightHours: false,
          positionIdCloses: undefined,
          trailingStops: true
        }
      }
    ]);
    expect(calls[0].url).toBe("http://localhost:8000/sse");
    expect(calls[0].body.params.name).toBe("get_account_info");
  });

  it("routes getEquityPositions() to get_positions tool and preserves fractional quantity fields", async () => {
    vi.stubGlobal("fetch", async () => {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify([
                  { symbol: "MSFT", qty: 20, avg_entry_price: 300, market_value: 6000 },
                  { symbol: "AAPL", quantity: "0.5", average_entry_price: "200", marketValue: "100" }
                ])
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");
    const positions = await gateway.getEquityPositions("MCP_ACC_1");

    expect(positions).toEqual([
      { symbol: "MSFT", quantity: 20, averageCost: 300, marketValue: 6000, sector: undefined, industry: undefined },
      { symbol: "AAPL", quantity: 0.5, averageCost: 200, marketValue: 100, sector: undefined, industry: undefined }
    ]);
  });

  it("default getEquityOrders asks MCP for status all so a just-filled order stays visible", async () => {
    const calls: Array<{ params?: { name?: string; arguments?: { status?: string } } }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body || "{}")));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify([
                  {
                    id: "ord-filled",
                    symbol: "AAPL",
                    side: "buy",
                    type: "market",
                    status: "filled",
                    qty: "1",
                    filled_qty: "1",
                    filled_avg_price: "190",
                    client_order_id: "ref-1",
                    created_at: "2026-08-20T14:00:00.000Z"
                  }
                ])
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");
    expect(gateway.ordersListIncludesTerminal).toBe(true);
    const orders = await gateway.getEquityOrders("MCP_ACC_1");

    expect(calls[0]?.params?.name).toBe("get_orders");
    expect(calls[0]?.params?.arguments?.status).toBe("all");
    expect(orders).toEqual([
      expect.objectContaining({
        id: "ord-filled",
        state: "filled",
        clientOrderId: "ref-1",
        filledQuantity: 1
      })
    ]);
  });

  it("routes placeEquityOrder() to order placement tool", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body || "{}")));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ id: "order_mcp_123", status: "accepted", filled_qty: 0, filled_avg_price: null })
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");
    const order = await gateway.placeEquityOrder({
      accountNumber: "MCP_ACC_1",
      symbol: "NVDA",
      side: "buy",
      type: "market",
      quantity: 5,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "client-ref-123"
    });

    expect(order.orderId).toBe("order_mcp_123");
    expect(order.state).toBe("accepted");
    expect(calls[0].params.name).toBe("place_market_order");
    expect(calls[0].params.arguments.qty).toBe("5");
  });

  it("logs alpaca-broker health on a successful REST SDK call", async () => {
    // No MCP path: fetch 500 forces the REST SDK fallback, where the raw getAccount() call runs.
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));

    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const { getDb } = await import("../src/lib/db");
    await getAlpacaGateway("local").getAccounts();

    const rows = getDb()
      .prepare("SELECT ok, key_source, user_id FROM api_health_log WHERE service = ? ORDER BY ts")
      .all("alpaca-broker") as Array<{ ok: number; key_source: string | null; user_id: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.ok === 1 && row.key_source === "user" && row.user_id === "local")).toBe(true);
  });

  it("logs an alpaca-broker health failure when the REST SDK call throws", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));

    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const { getDb } = await import("../src/lib/db");
    const gateway = getAlpacaGateway("local");
    // Force the underlying SDK call to reject so the failure branch logs.
    (gateway as unknown as { alpaca: { getAccount: () => Promise<never> } }).alpaca.getAccount = async () => {
      throw new Error("boom");
    };

    await expect(gateway.getAccounts()).rejects.toThrow("boom");

    const rows = getDb()
      .prepare("SELECT ok, error_text FROM api_health_log WHERE service = ? ORDER BY ts")
      .all("alpaca-broker") as Array<{ ok: number; error_text: string | null }>;
    expect(rows.some((row) => row.ok === 0 && row.error_text === "boom")).toBe(true);
  });

  it("retries getAccount when the first REST SDK call stays pending", async () => {
    // Live first wait is 16s (above alpaca-broker max 14416ms).  Advancing that
    // under fake timers while the first SDK promise never settles hangs vitest
    // (`advanceTimersByTimeAsync` waits on pending promises).  Mock a short
    // budget so this test proves the retry path without waiting the live 16s.
    vi.doMock("../src/lib/inflight-deadline", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/lib/inflight-deadline")>();
      return {
        ...actual,
        ALPACA_ACCOUNT_READ_FIRST_MS: 40,
        ALPACA_ACCOUNT_READ_RETRY_MS: 40,
        alpacaAccountReadBudgetMs: () => ({ firstMs: 40, retryMs: 40 })
      };
    });
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));

    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");
    let calls = 0;
    (gateway as unknown as { alpaca: { getAccount: () => Promise<Record<string, string>> } }).alpaca.getAccount = () => {
      calls += 1;
      if (calls === 1) return new Promise(() => undefined);
      return Promise.resolve({
        account_number: "RETRY_ACC",
        portfolio_value: "10000",
        buying_power: "5000",
        equity: "8000",
        cash: "2000"
      });
    };

    try {
      const accounts = await gateway.getAccounts();
      expect(accounts[0]?.accountNumber).toBe("RETRY_ACC");
      expect(calls).toBe(2);
    } finally {
      vi.doUnmock("../src/lib/inflight-deadline");
    }
  });

  it("passes an abort signal on MCP fetch so a hung sidecar can fall back to REST", async () => {
    let seenSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return new Response(null, { status: 500 });
    });

    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    await getAlpacaGateway("local").getAccounts();
    expect(seenSignal).toBeDefined();
  });

  it("falls back to REST client when fetch errors or is rejected", async () => {
    vi.stubGlobal("fetch", async () => {
      return new Response(null, { status: 500 }); // Server error
    });

    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");
    
    // getAccounts will fall back to REST (which returns mock REST account MOCK_REST_ACC_1)
    const accounts = await gateway.getAccounts();
    expect(accounts).toEqual([
      {
        accountNumber: "MOCK_REST_ACC_1",
        label: "Alpaca Paper",
        agenticAllowed: true,
        capabilities: {
          equityTrading: true,
          shortSelling: false,
          optionsTrading: false,
          futuresTrading: false,
          cryptoTrading: false,
          marginEnabled: false,
          accountType: "brokerage",
          extendedHours: true,
          fractional: true,
          marketHours: ["regular_hours", "extended_hours"],
          minOrderNotional: undefined,
          minShareQuantity: undefined,
          nativeBrackets: true,
          optionsOrders: false,
          orderTypes: ["market", "limit", "stop_market", "stop_limit"],
          overnightHours: false,
          positionIdCloses: undefined,
          trailingStops: true
        }
      }
    ]);
  });

  it("does not REST-place after an MCP timeout; reconciles the live order by client_order_id", async () => {
    vi.stubGlobal("fetch", async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });
    restPlace.sendRequest = async (path: string) => {
      expect(path).toContain("orders:by_client_order_id/client-ref-timeout");
      return { id: "order_mcp_already", status: "accepted", filled_qty: "0", filled_avg_price: null };
    };

    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");
    const order = await gateway.placeEquityOrder({
      accountNumber: "MCP_ACC_1",
      symbol: "NVDA",
      side: "buy",
      type: "market",
      quantity: 5,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "client-ref-timeout"
    });

    expect(order.orderId).toBe("order_mcp_already");
    expect(restPlace.createCalls).toBe(0);
  });

  it("does not REST-place after MCP HTTP 500 when reconcile finds nothing", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));

    const { getAlpacaGateway, AlpacaMcpWriteAmbiguousError } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");
    await expect(gateway.placeEquityOrder({
      accountNumber: "MCP_ACC_1",
      symbol: "NVDA",
      side: "buy",
      type: "market",
      quantity: 5,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "client-ref-500"
    })).rejects.toBeInstanceOf(AlpacaMcpWriteAmbiguousError);
    expect(restPlace.createCalls).toBe(0);
  });

  it("REST-places only when MCP reports the tool is missing", async () => {
    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32601, message: "Method not found" } }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));

    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");
    const order = await gateway.placeEquityOrder({
      accountNumber: "MCP_ACC_1",
      symbol: "NVDA",
      side: "buy",
      type: "market",
      quantity: 5,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "client-ref-missing-tool"
    });
    expect(order.orderId).toBe("order_rest_new");
    expect(restPlace.createCalls).toBe(1);
  });

  it("does not REST-cancel after MCP timeout when the order is already canceled", async () => {
    let cancelCalls = 0;
    vi.stubGlobal("fetch", async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });
    restPlace.getOrder = async (orderId: string) => {
      expect(orderId).toBe("ord-already-canceled");
      return { id: orderId, status: "canceled" };
    };

    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");
    (gateway as unknown as { alpaca: { cancelOrder: () => Promise<void> } }).alpaca.cancelOrder = async () => {
      cancelCalls += 1;
    };
    const result = await gateway.cancelEquityOrder("MCP_ACC_1", "ord-already-canceled");
    expect(result.state).toBe("cancel_requested");
    expect(cancelCalls).toBe(0);
  });
});
