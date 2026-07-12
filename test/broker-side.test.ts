import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { toBrokerSide, isShortIntent, isRejectedOrCanceledState } from "../src/lib/broker-side";
import { toMcpOrder } from "../src/lib/robinhood";
import type { EquityOrderInput, OrderSide } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-broker-side-${randomUUID()}.db`)}`;
});

const order = (side: OrderSide): EquityOrderInput => ({
  accountNumber: "ACCT-1",
  symbol: "AAPL",
  side,
  type: "market",
  quantity: 1,
  timeInForce: "gfd",
  marketHours: "regular_hours"
});

describe("toBrokerSide — intent side → broker buy/sell", () => {
  it("maps buy→buy, sell→sell, short→sell, cover→buy", () => {
    expect(toBrokerSide("buy")).toBe("buy");
    expect(toBrokerSide("sell")).toBe("sell");
    expect(toBrokerSide("short")).toBe("sell"); // open a short by selling
    expect(toBrokerSide("cover")).toBe("buy"); // close a short by buying
  });

  it("isShortIntent flags only short/cover", () => {
    expect(isShortIntent("short")).toBe(true);
    expect(isShortIntent("cover")).toBe(true);
    expect(isShortIntent("buy")).toBe(false);
    expect(isShortIntent("sell")).toBe(false);
  });
});

describe("isRejectedOrCanceledState — broker-agnostic terminal-decline check", () => {
  it("recognizes both spellings of canceled and other terminal-decline states", () => {
    expect(isRejectedOrCanceledState("rejected")).toBe(true);
    expect(isRejectedOrCanceledState("canceled")).toBe(true);
    expect(isRejectedOrCanceledState("cancelled")).toBe(true);
    expect(isRejectedOrCanceledState("failed")).toBe(true);
    expect(isRejectedOrCanceledState("expired")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isRejectedOrCanceledState("REJECTED")).toBe(true);
    expect(isRejectedOrCanceledState("Cancelled")).toBe(true);
  });

  it("does not flag accepted/filled/unknown states", () => {
    expect(isRejectedOrCanceledState("filled")).toBe(false);
    expect(isRejectedOrCanceledState("partially_filled")).toBe(false);
    expect(isRejectedOrCanceledState("accepted")).toBe(false);
    expect(isRejectedOrCanceledState("new")).toBe(false);
    expect(isRejectedOrCanceledState("submitted")).toBe(false);
    expect(isRejectedOrCanceledState(undefined)).toBe(false);
    expect(isRejectedOrCanceledState(null)).toBe(false);
  });
});

describe("Robinhood toMcpOrder — fail closed on short/cover", () => {
  it("throws for short and cover (Robinhood has no equity shorting), never emitting an invalid side", () => {
    expect(() => toMcpOrder(order("short"))).toThrow(/short/i);
    expect(() => toMcpOrder(order("cover"))).toThrow(/short/i);
  });

  it("passes buy/sell through with a broker-valid side", () => {
    expect(toMcpOrder(order("buy")).side).toBe("buy");
    expect(toMcpOrder(order("sell")).side).toBe("sell");
  });
});

// The Alpaca SDK is mocked so we can capture exactly what side reaches createOrder. With no active
// connected account the gateway uses the REST path (isMcp=false) and calls this.alpaca.createOrder.
const createOrder = vi.fn(async (opts: Record<string, unknown>) => ({
  id: "ord-1",
  status: "accepted",
  filled_qty: "0",
  filled_avg_price: null,
  ...opts
}));
vi.mock("@alpacahq/alpaca-trade-api", () => ({
  default: vi.fn(function () {
    return { createOrder, getAccount: vi.fn(), getPositions: vi.fn() };
  })
}));

describe("Alpaca placeEquityOrder — translates short/cover before the network call", () => {
  it("submits short as a broker 'sell' and cover as a broker 'buy'", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    createOrder.mockClear();
    await gateway.placeEquityOrder({ ...order("short"), refId: "r1" });
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(createOrder.mock.calls[0][0].side).toBe("sell");

    createOrder.mockClear();
    await gateway.placeEquityOrder({ ...order("cover"), refId: "r2" });
    expect(createOrder.mock.calls[0][0].side).toBe("buy");

    createOrder.mockClear();
    await gateway.placeEquityOrder({ ...order("buy"), refId: "r3" });
    expect(createOrder.mock.calls[0][0].side).toBe("buy");
  });
});
