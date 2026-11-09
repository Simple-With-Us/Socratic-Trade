import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rh-mcp-${randomUUID()}.db`)}`;
});

describe("robinhood mcp transport", () => {
  it("sends streamable HTTP headers and unwraps SSE tool results", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTH_TOKEN", "test-token");
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const result = {
        jsonrpc: "2.0",
        id: "1",
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ data: { accounts: [{ account_number: "A1", nickname: "Agentic" }] }, guide: "ok" })
            }
          ]
        }
      };
      return new Response(`event: message\ndata: ${JSON.stringify(result)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });

    const { callRobinhoodMcpTool, ROBINHOOD_TRADING_MCP_URL } = await import("../src/lib/robinhood");
    // The legacy env override is migrated into local's stored token at boot; exercise that path.
    const { migrateLocalRobinhoodToken } = await import("../src/lib/mcp-oauth");
    migrateLocalRobinhoodToken();

    const raw = await callRobinhoodMcpTool("local", "get_accounts", {});

    expect(raw).toEqual({ accounts: [{ account_number: "A1", nickname: "Agentic" }] });
    expect(calls[0].url).toBe(ROBINHOOD_TRADING_MCP_URL);
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("accept")).toBe("application/json, text/event-stream");
    expect(headers.get("mcp-protocol-version")).toBe("2025-03-26");
    expect(headers.get("authorization")).toBe("Bearer test-token");
  });

  it("parses JSON structuredContent tool results", async () => {
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    vi.stubGlobal("fetch", async () => {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: {
            structuredContent: { data: { quotes: [{ symbol: "AAPL", price: "200" }] }, guide: "ok" }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { callRobinhoodMcpTool } = await import("../src/lib/robinhood");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-a", { accessToken: "test-token", tokenType: "Bearer" });

    await expect(callRobinhoodMcpTool("user-a", "get_equity_quotes", { symbols: ["AAPL"] })).resolves.toEqual({
      quotes: [{ symbol: "AAPL", price: "200" }]
    });
  });

  it("calls the Robinhood quote tool with only the symbols argument", async () => {
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? "{}"));
      calls.push(request);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            structuredContent: {
              data: {
                quotes: [
                  { symbol: "AAPL", price: "200" },
                  { symbol: "MSFT", last_trade_price: "450" }
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

    const quotes = await getRobinhoodGateway("user-a").getEquityQuotes("RH-ACCOUNT", ["aapl", "msft"]);

    expect(quotes.AAPL?.price).toBe(200);
    expect(quotes.MSFT?.price).toBe(450);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "tools/call",
      params: {
        name: "get_equity_quotes",
        arguments: { symbols: ["AAPL", "MSFT"] }
      }
    });
    const firstCall = calls[0] as { params: { arguments: Record<string, unknown> } };
    expect(firstCall.params.arguments).not.toHaveProperty("account_number");
  });

  it("chunks a 250-name universe so Robinhood never sees more than 10 symbols", async () => {
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    const { chunkRobinhoodSymbols, ROBINHOOD_EQUITY_SYMBOL_CHUNK } = await import("../src/lib/robinhood");
    const universe = Array.from({ length: 250 }, (_, i) => `SYM${String(i + 1).padStart(3, "0")}`);
    const chunks = chunkRobinhoodSymbols(universe);
    expect(chunks).toHaveLength(25);
    expect(chunks.every((chunk) => chunk.length <= ROBINHOOD_EQUITY_SYMBOL_CHUNK)).toBe(true);
    expect(chunks.flat()).toHaveLength(250);
    expect(new Set(chunks.flat()).size).toBe(250);

    const calls: string[][] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? "{}"));
      const symbols = request.params.arguments.symbols as string[];
      if (symbols.length > 10) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { message: `too many symbols (max 10, got ${symbols.length})` }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      calls.push(symbols);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            structuredContent: {
              data: {
                quotes: symbols.map((symbol, idx) => ({ symbol, price: String(10 + idx) }))
              }
            }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { getRobinhoodGateway } = await import("../src/lib/robinhood");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-a", { accessToken: "test-token", tokenType: "Bearer" });

    const quotes = await getRobinhoodGateway("user-a").getEquityQuotes("RH-ACCOUNT", universe);
    expect(calls.length).toBe(25);
    expect(calls.every((chunk) => chunk.length <= 10)).toBe(true);
    expect(Object.keys(quotes)).toHaveLength(250);
    expect(quotes.SYM001?.price).toBe(10);
    expect(quotes.SYM250?.price).toBeGreaterThan(0);
  });

  it("keeps quotes from other chunks when one Robinhood chunk hits max-10", async () => {
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? "{}"));
      const symbols = request.params.arguments.symbols as string[];
      if (symbols.includes("BAD1")) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { message: "too many symbols (max 10, got 10)" }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            structuredContent: {
              data: { quotes: symbols.map((symbol) => ({ symbol, price: "12" })) }
            }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { getRobinhoodGateway } = await import("../src/lib/robinhood");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-a", { accessToken: "test-token", tokenType: "Bearer" });
    const first = Array.from({ length: 10 }, (_, i) => `OK${i}`);
    const second = Array.from({ length: 10 }, (_, i) => `BAD${i}`);
    const quotes = await getRobinhoodGateway("user-a").getEquityQuotes("RH-ACCOUNT", [...first, ...second]);
    expect(quotes.OK0?.price).toBe(12);
    expect(quotes.BAD0).toBeUndefined();
  });

  it("maps equity orders including limit/stop price (Robinhood `price` = limit) and time-in-force", async () => {
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
                orders: [
                  {
                    id: "ord-1",
                    symbol: "aapl",
                    side: "buy",
                    type: "limit",
                    state: "confirmed",
                    quantity: "10",
                    price: "199.5",
                    stop_price: null,
                    time_in_force: "gfd",
                    created_at: "2026-07-01T14:00:00Z"
                  },
                  {
                    id: "ord-2",
                    symbol: "MSFT",
                    side: "sell",
                    type: "stop_limit",
                    state: "queued",
                    quantity: "3",
                    price: "440",
                    stop_price: "445",
                    time_in_force: "gtc",
                    created_at: "2026-07-01T15:00:00Z"
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

    const orders = await getRobinhoodGateway("user-a").getEquityOrders("RH-ACCOUNT");

    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({
      id: "ord-1",
      symbol: "AAPL",
      limitPrice: 199.5,
      timeInForce: "gfd"
    });
    expect(orders[0].stopPrice).toBeUndefined();
    expect(orders[1]).toMatchObject({
      id: "ord-2",
      limitPrice: 440,
      stopPrice: 445,
      timeInForce: "gtc"
    });
  });

  it("reports missing auth without calling the MCP server", async () => {
    vi.stubEnv("ROBINHOOD_ADAPTER", "mcp");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { getRobinhoodMcpHealth } = await import("../src/lib/robinhood");
    const health = await getRobinhoodMcpHealth("user-a");

    expect(health.ok).toBe(false);
    expect(health.configured).toBe(true);
    expect(health.authenticated).toBe(false);
    expect(health.error).toContain("No Robinhood MCP access token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists available tools through the health check", async () => {
    vi.stubEnv("ROBINHOOD_ADAPTER", "mcp");
    vi.stubEnv("ROBINHOOD_MCP_AUTH_TOKEN", "test-token");
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? "{}"));
      methods.push(request.method);
      if (request.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-03-26" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: [{ name: "place_equity_order" }, { name: "get_accounts" }, { name: "get_equity_quotes" }] }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { getRobinhoodMcpHealth } = await import("../src/lib/robinhood");
    // The legacy env override is migrated into local's stored token at boot; exercise that path.
    const { migrateLocalRobinhoodToken } = await import("../src/lib/mcp-oauth");
    migrateLocalRobinhoodToken();

    // Health check as the `local` primary user (its token came from the boot migration).
    await expect(getRobinhoodMcpHealth("local")).resolves.toMatchObject({
      ok: true,
      authenticated: true,
      tools: ["get_accounts", "get_equity_quotes", "place_equity_order"]
    });
    expect(methods).toEqual(["initialize", "tools/list"]);
  });

  it("logs robinhood-broker health on a successful tool call", async () => {
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    vi.stubGlobal("fetch", async () => {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: { structuredContent: { data: { accounts: [] }, guide: "ok" } }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { callRobinhoodMcpTool } = await import("../src/lib/robinhood");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    const { getDb } = await import("../src/lib/db");
    setMcpOAuthTokens("user-a", { accessToken: "test-token", tokenType: "Bearer" });

    await callRobinhoodMcpTool("user-a", "get_accounts", {});

    const rows = getDb()
      .prepare("SELECT ok, key_source, user_id FROM api_health_log WHERE service = ? ORDER BY ts")
      .all("robinhood-broker") as Array<{ ok: number; key_source: string | null; user_id: string | null }>;
    expect(rows.some((row) => row.ok === 1 && row.key_source === "user" && row.user_id === "user-a")).toBe(true);
  });

  it("logs a robinhood-broker health failure when a tool call throws", async () => {
    vi.stubGlobal("fetch", async () => {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32000, message: "not authorized" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const { callRobinhoodMcpTool } = await import("../src/lib/robinhood");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    const { getDb } = await import("../src/lib/db");
    setMcpOAuthTokens("user-a", { accessToken: "test-token", tokenType: "Bearer" });

    await expect(callRobinhoodMcpTool("user-a", "get_accounts", {})).rejects.toThrow("not authorized");

    const rows = getDb()
      .prepare("SELECT ok, error_text FROM api_health_log WHERE service = ? ORDER BY ts")
      .all("robinhood-broker") as Array<{ ok: number; error_text: string | null }>;
    expect(rows.some((row) => row.ok === 0 && row.error_text === "not authorized")).toBe(true);
  });

  it("surfaces JSON-RPC errors with the broker message", async () => {
    vi.stubGlobal("fetch", async () => {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32000, message: "not authorized" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const { callRobinhoodMcpTool } = await import("../src/lib/robinhood");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-a", { accessToken: "test-token", tokenType: "Bearer" });

    await expect(callRobinhoodMcpTool("user-a", "get_accounts", {})).rejects.toThrow("not authorized");
  });

  it("parses cash-only Robinhood portfolio shapes without zeroing balances", async () => {
    const { portfolioFromRobinhoodRaw } = await import("../src/lib/robinhood");

    const portfolio = portfolioFromRobinhoodRaw("713670347", {
      buying_power: { buying_power: "100.00", display_currency: "USD" },
      cash_balances: { cash_available_for_withdrawal: "$100.00" },
      equity_market_value: "0"
    });

    expect(portfolio).toMatchObject({
      accountNumber: "713670347",
      totalMarketValue: 100,
      buyingPower: 100,
      equityMarketValue: 0,
      cash: 100
    });
  });

  it("infers a cash-only total from buying power when Robinhood omits cash fields", async () => {
    const { portfolioFromRobinhoodRaw } = await import("../src/lib/robinhood");

    const portfolio = portfolioFromRobinhoodRaw("713670347", {
      buyingPower: { amount: "100.00" },
      stock_value: "0.00",
      options_value: "0.00"
    });

    expect(portfolio.totalMarketValue).toBe(100);
    expect(portfolio.cash).toBe(100);
    expect(portfolio.buyingPower).toBe(100);
  });

  it("does not let an explicit zero total override positive cash", async () => {
    const { portfolioFromRobinhoodRaw } = await import("../src/lib/robinhood");

    const portfolio = portfolioFromRobinhoodRaw("713670347", {
      total_value: "0.00",
      buying_power: { amount: "100.00" },
      cash: "100.00"
    });

    expect(portfolio.totalMarketValue).toBe(100);
    expect(portfolio.cash).toBe(100);
  });

  it("maps a legacy historicals span onto start_time without sending symbol/span", async () => {
    const { robinhoodHistoricalsStartTime } = await import("../src/lib/robinhood");
    const now = Date.parse("2026-08-13T16:00:00.000Z");
    expect(robinhoodHistoricalsStartTime("5year", now)).toBe(new Date(now - 5 * 365.25 * 24 * 60 * 60 * 1000).toISOString());
  });

  it("calls option-chain tools with only schema-legal arguments (no symbol/symbols extras)", async () => {
    vi.stubEnv("ROBINHOOD_ADAPTER", "mcp");
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? "{}"));
      if (request.method === "tools/call") {
        calls.push({ name: request.params.name, args: request.params.arguments });
      }
      const payload =
        request.params?.name === "get_equity_quotes"
          ? { quotes: [{ symbol: "AAPL", last_trade_price: "200" }] }
          : { results: [] };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { structuredContent: { data: payload, guide: "ok" } }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { fetchRobinhoodOptionChain } = await import("../src/lib/robinhood");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-a", { accessToken: "test-token", tokenType: "Bearer" });

    await fetchRobinhoodOptionChain("aapl", "user-a", { expiration: "2026-09-18", type: "call" });

    const chain = calls.find((c) => c.name === "get_option_chains");
    const instruments = calls.find((c) => c.name === "get_option_instruments");
    expect(chain?.args).toEqual({ underlying_symbol: "AAPL" });
    expect(chain?.args).not.toHaveProperty("symbol");
    expect(chain?.args).not.toHaveProperty("symbols");
    expect(instruments?.args).toEqual({
      chain_symbol: "AAPL",
      expiration_dates: "2026-09-18",
      type: "call"
    });
    expect(instruments?.args).not.toHaveProperty("symbol");
    expect(instruments?.args).not.toHaveProperty("symbols");
    expect(instruments?.args).not.toHaveProperty("underlying_symbol");
  });

  it("calls get_equity_historicals with symbols+start_time, not symbol or span", async () => {
    vi.stubEnv("ROBINHOOD_ADAPTER", "mcp");
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? "{}"));
      if (request.method === "tools/call") calls.push(request.params.arguments);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { structuredContent: { data: { historicals: [] }, guide: "ok" } }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { fetchRobinhoodHistoricals } = await import("../src/lib/robinhood");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-a", { accessToken: "test-token", tokenType: "Bearer" });

    await fetchRobinhoodHistoricals("aapl", { interval: "day", span: "5year", userId: "user-a" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      symbols: ["AAPL"],
      interval: "day",
      bounds: "regular"
    });
    expect(calls[0]).toHaveProperty("start_time");
    expect(calls[0]).not.toHaveProperty("symbol");
    expect(calls[0]).not.toHaveProperty("span");
  });
});

describe("toMcpOrder — fractional/notional routing", () => {
  const base = {
    accountNumber: "RH123",
    symbol: "GOOG",
    side: "buy",
    timeInForce: "gfd",
    marketHours: "regular_hours"
  } as const;

  it("coerces a dollar-routed limit order into a regular-hours MARKET order (Robinhood fractional is market-only)", async () => {
    const { toMcpOrder } = await import("../src/lib/robinhood");
    // $1 GOOG (~$180) is a sub-share/fractional buy the LLM had shaped as a limit in extended hours.
    const order = toMcpOrder({ ...base, type: "limit", dollarAmount: 1, limitPrice: 180.12, marketHours: "extended_hours" });
    expect(order.type).toBe("market");
    expect(order.dollar_amount).toBe("1.00");
    expect(order.limit_price).toBeUndefined();
    expect(order.stop_price).toBeUndefined();
    expect(order.market_hours).toBe("regular_hours");
    expect(order.time_in_force).toBe("gfd");
    expect(order.quantity).toBeUndefined();
  });

  it("preserves a dollar-routed SELL limit instead of liquidating immediately", async () => {
    const { toMcpOrder } = await import("../src/lib/robinhood");
    const order = toMcpOrder({ ...base, side: "sell", type: "limit", dollarAmount: 5, limitPrice: 12.3, timeInForce: "gtc" });
    expect(order.type).toBe("limit");
    expect(order.dollar_amount).toBe("5.00");
    expect(order.limit_price).toBe("12.30");
    expect(order.time_in_force).toBe("gtc");
  });

  it("preserves a whole-share limit order unchanged (marketable-limit entries still work)", async () => {
    const { toMcpOrder } = await import("../src/lib/robinhood");
    const order = toMcpOrder({ ...base, type: "limit", quantity: 3, limitPrice: 180.5 });
    expect(order.type).toBe("limit");
    expect(order.quantity).toBe("3");
    expect(order.limit_price).toBe("180.50");
    expect(order.dollar_amount).toBeUndefined();
  });

  it("leaves a whole-share market order as market", async () => {
    const { toMcpOrder } = await import("../src/lib/robinhood");
    const order = toMcpOrder({ ...base, type: "market", quantity: 2 });
    expect(order.type).toBe("market");
    expect(order.quantity).toBe("2");
  });

  it("does NOT coerce a dollar-sized STOP into an immediate market order (keeps stop semantics)", async () => {
    const { toMcpOrder } = await import("../src/lib/robinhood");
    const stopMarket = toMcpOrder({ ...base, side: "sell", type: "stop_market", dollarAmount: 5, stopPrice: 150 });
    expect(stopMarket.type).toBe("stop_market");
    expect(stopMarket.stop_price).toBe("150.00");
    const stopLimit = toMcpOrder({ ...base, side: "sell", type: "stop_limit", dollarAmount: 5, stopPrice: 150, limitPrice: 149.5 });
    expect(stopLimit.type).toBe("stop_limit");
    expect(stopLimit.stop_price).toBe("150.00");
    expect(stopLimit.limit_price).toBe("149.50");
  });

  it("coerces a fractional BUY quantity-only limit to GFD market too (not just dollar-routed)", async () => {
    const { toMcpOrder } = await import("../src/lib/robinhood");
    const order = toMcpOrder({ ...base, side: "buy", type: "limit", quantity: 0.5, limitPrice: 180.4, timeInForce: "gtc" });
    expect(order.type).toBe("market");
    expect(order.limit_price).toBeUndefined();
    expect(order.market_hours).toBe("regular_hours");
    expect(order.time_in_force).toBe("gfd");
    expect(order.quantity).toBe("0.5");
  });
});

describe("HttpMcpRobinhoodGateway.placeEquityOrder — order confirmation", () => {
  const equityOrder = {
    accountNumber: "RH-ACCOUNT",
    symbol: "AAPL",
    side: "buy" as const,
    type: "market" as const,
    quantity: 1,
    timeInForce: "gfd" as const,
    marketHours: "regular_hours" as const,
    refId: "ref-1"
  };

  it("throws instead of fabricating an order id when the MCP response has none", async () => {
    // Regression: String(undefined ?? undefined) silently became the literal string "undefined",
    // which the caller would have recorded as a confirmed "placed" order that could never be
    // matched against Robinhood's real order list during reconciliation.
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { structuredContent: { data: { state: "confirmed" }, guide: "ok" } }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { getRobinhoodGateway } = await import("../src/lib/robinhood");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-a", { accessToken: "test-token", tokenType: "Bearer" });

    await expect(getRobinhoodGateway("user-a").placeEquityOrder(equityOrder)).rejects.toThrow(/no order id/i);
  });

  it("returns the order id and state when the MCP response is well-formed", async () => {
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { structuredContent: { data: { id: "rh-order-1", state: "confirmed" }, guide: "ok" } }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { getRobinhoodGateway } = await import("../src/lib/robinhood");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-a", { accessToken: "test-token", tokenType: "Bearer" });

    const executed = await getRobinhoodGateway("user-a").placeEquityOrder(equityOrder);
    expect(executed.orderId).toBe("rh-order-1");
    expect(executed.state).toBe("confirmed");
  });
});
