import { describe, expect, it } from "vitest";
import { fromAlpacaSymbol, mapAlpacaOrder, mapAlpacaOrderType, mapAlpacaOrderTypeWrite, mcpWriteFailureAllowsRestFallback, parseAlpacaPosition, toAlpacaSymbol } from "../src/lib/alpaca";

describe("mapAlpacaOrderType", () => {
  it("maps Alpaca raw order types to our OrderType union (no leaked raw values)", () => {
    expect(mapAlpacaOrderType("market")).toBe("market");
    expect(mapAlpacaOrderType("limit")).toBe("limit");
    expect(mapAlpacaOrderType("stop")).toBe("stop_market"); // was leaking raw "stop"
    expect(mapAlpacaOrderType("stop_limit")).toBe("stop_limit");
    expect(mapAlpacaOrderType("trailing_stop")).toBe("stop_market");
  });

  it("maps our stop_market union to Alpaca wire type stop on WRITE and keeps stop_limit", () => {
    expect(mapAlpacaOrderTypeWrite("stop_market")).toBe("stop");
    expect(mapAlpacaOrderTypeWrite("stop_limit")).toBe("stop_limit");
    expect(mapAlpacaOrderTypeWrite("market")).toBe("market");
    expect(mapAlpacaOrderTypeWrite("limit")).toBe("limit");
  });

  it("falls back to market for unknown/absent types instead of leaking", () => {
    expect(mapAlpacaOrderType("bracket")).toBe("market");
    expect(mapAlpacaOrderType(undefined)).toBe("market");
    expect(mapAlpacaOrderType(null)).toBe("market");
  });
});

describe("mcpWriteFailureAllowsRestFallback", () => {
  it("allows REST fallback only for definite tool-not-found / 4xx-before-send", () => {
    expect(mcpWriteFailureAllowsRestFallback(new Error("Alpaca MCP -32601 Method not found"))).toBe(true);
    expect(mcpWriteFailureAllowsRestFallback(new Error("unknown tool place_market_order"))).toBe(true);
    expect(mcpWriteFailureAllowsRestFallback(new Error("Alpaca MCP HTTP 404"))).toBe(true);
    expect(mcpWriteFailureAllowsRestFallback(new Error("Alpaca MCP HTTP 400"))).toBe(true);
    expect(mcpWriteFailureAllowsRestFallback(new Error("Alpaca MCP HTTP 401"))).toBe(true);
  });

  it("refuses REST fallback for timeout, abort, 5xx, 409, and network errors", () => {
    expect(mcpWriteFailureAllowsRestFallback(new Error("Alpaca MCP HTTP 500"))).toBe(false);
    expect(mcpWriteFailureAllowsRestFallback(new Error("Alpaca MCP HTTP 409"))).toBe(false);
    expect(mcpWriteFailureAllowsRestFallback(new Error("Alpaca MCP HTTP 429"))).toBe(false);
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    expect(mcpWriteFailureAllowsRestFallback(timeout)).toBe(false);
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    expect(mcpWriteFailureAllowsRestFallback(abort)).toBe(false);
    expect(mcpWriteFailureAllowsRestFallback(new Error("fetch failed"))).toBe(false);
  });
});

describe("mapAlpacaOrder", () => {
  it("maps a raw Alpaca order (status→state, type mapped) into EquityOrder", () => {
    const order = mapAlpacaOrder({
      id: "o1",
      symbol: "aapl",
      side: "sell",
      type: "stop",
      status: "new",
      qty: "10",
      filled_qty: "0",
      filled_avg_price: null,
      created_at: "2026-06-25T00:00:00Z",
      client_order_id: "c1"
    });
    expect(order).toMatchObject({
      id: "o1",
      symbol: "AAPL",
      side: "sell",
      type: "stop_market",
      state: "new",
      quantity: 10,
      filledQuantity: 0,
      clientOrderId: "c1",
      placedAgent: "alpaca"
    });
    expect(order.averagePrice).toBeUndefined();
  });

  it("normalizes a dot-notation share-class symbol from Alpaca back to our hyphen convention", () => {
    const order = mapAlpacaOrder({
      id: "o2",
      symbol: "BRK.B",
      side: "buy",
      type: "market",
      status: "filled",
      qty: "1",
      created_at: "2026-06-25T00:00:00Z"
    });
    expect(order.symbol).toBe("BRK-B");
  });

  it("carries limit/stop price and time-in-force through to EquityOrder", () => {
    const order = mapAlpacaOrder({
      id: "o3",
      symbol: "MSFT",
      side: "buy",
      type: "stop_limit",
      status: "new",
      qty: "5",
      limit_price: "410.5",
      stop_price: "405",
      time_in_force: "gtc",
      created_at: "2026-07-01T00:00:00Z"
    });
    expect(order.limitPrice).toBe(410.5);
    expect(order.stopPrice).toBe(405);
    expect(order.timeInForce).toBe("gtc");
  });

  it("leaves limit/stop/TIF undefined when Alpaca omits them (market order)", () => {
    const order = mapAlpacaOrder({
      id: "o4",
      symbol: "AAPL",
      side: "buy",
      type: "market",
      status: "filled",
      qty: "1",
      limit_price: null,
      stop_price: null,
      created_at: "2026-07-01T00:00:00Z"
    });
    expect(order.limitPrice).toBeUndefined();
    expect(order.stopPrice).toBeUndefined();
    expect(order.timeInForce).toBeUndefined();
  });
});

describe("toAlpacaSymbol / fromAlpacaSymbol", () => {
  it("converts our hyphenated share-class symbol to Alpaca's dot notation and back", () => {
    // Regression: Alpaca rejects "BRK-B" with HTTP 422 "asset not found" — it requires "BRK.B".
    expect(toAlpacaSymbol("BRK-B")).toBe("BRK.B");
    expect(toAlpacaSymbol("brk-b")).toBe("BRK.B");
    expect(fromAlpacaSymbol("BRK.B")).toBe("BRK-B");
  });

  it("leaves plain symbols unaffected aside from normalization", () => {
    expect(toAlpacaSymbol("aapl")).toBe("AAPL");
    expect(fromAlpacaSymbol("AAPL")).toBe("AAPL");
  });
});

describe("parseAlpacaPosition", () => {
  it("normalizes a dot-notation share-class symbol from Alpaca back to our hyphen convention", () => {
    const position = parseAlpacaPosition({ symbol: "BRK.B", qty: "5", avg_entry_price: "400", market_value: "2000" });
    expect(position.symbol).toBe("BRK-B");
  });
});
