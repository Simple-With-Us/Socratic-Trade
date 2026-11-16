import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertKalshiOrderInput,
  evaluateKalshiOrderPolicy,
  kalshiLiveOrdersEnvEnabled,
  placeKalshiEventOrder,
  cancelKalshiEventOrder
} from "../src/lib/kalshi-trading";

const order = {
  ticker: "KXFEDDECISION-26SEP-C25",
  side: "yes" as const,
  action: "buy" as const,
  count: 5,
  type: "limit" as const,
  priceCents: 44
};

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `kalshi-trading-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Kalshi trading kill switch", () => {
  it("defaults live orders OFF", () => {
    expect(kalshiLiveOrdersEnvEnabled({})).toBe(false);
    expect(kalshiLiveOrdersEnvEnabled({ KALSHI_LIVE_ORDERS: "on" })).toBe(true);
  });

  it("blocks when the event-contract sleeve is off", () => {
    const d = evaluateKalshiOrderPolicy({ eventContractsEnabled: false }, { KALSHI_ENV: "demo" });
    expect(d.allowed).toBe(false);
  });

  it("allows paper/dry-run when the sleeve is on and credentials exist, but not live", () => {
    const env = {
      KALSHI_ENV: "demo",
      KALSHI_API_KEY_ID: "key-id",
      KALSHI_PRIVATE_KEY_PEM: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----"
    };
    const dry = evaluateKalshiOrderPolicy({ eventContractsEnabled: true }, env);
    expect(dry).toEqual({ allowed: true, live: false });
    const live = evaluateKalshiOrderPolicy(
      { eventContractsEnabled: true, kalshiLiveOrdersEnabled: true },
      { ...env, KALSHI_LIVE_ORDERS: "on" }
    );
    expect(live).toEqual({ allowed: true, live: true });
  });

  it("dry-runs a place without calling fetch when live is off", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("network should not run"); }) as unknown as typeof fetch;
    const result = await placeKalshiEventOrder({
      order,
      policy: { eventContractsEnabled: true },
      env: {
        KALSHI_ENV: "demo",
        KALSHI_API_KEY_ID: "key-id",
        KALSHI_PRIVATE_KEY_PEM: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----"
      },
      fetchImpl
    });
    expect(result.status).toBe("dry_run");
    expect(result.submitted?.ticker).toBe(order.ticker);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("dry-runs cancel the same way", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await cancelKalshiEventOrder({
      orderId: "ord-1",
      policy: { eventContractsEnabled: true },
      env: {
        KALSHI_ENV: "demo",
        KALSHI_API_KEY_ID: "key-id",
        KALSHI_PRIVATE_KEY_PEM: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----"
      },
      fetchImpl
    });
    expect(result.status).toBe("dry_run");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a bad price before any network", () => {
    expect(assertKalshiOrderInput({ ...order, priceCents: 0 })).toMatch(/priceCents/);
    expect(assertKalshiOrderInput({ ...order, count: 0 })).toMatch(/count/);
  });
});
