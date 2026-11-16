/**
 * Unit tests for Kalshi broker gateway integration.
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KalshiBrokerGateway, getKalshiGateway } from "../src/lib/kalshi-broker";
import { upsertConnectedAccount } from "../src/lib/db";
import { mergeAccountCapabilities, knownBrokerLimits } from "../src/lib/venue-contract-pure";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `kalshi-broker-test-${randomUUID()}.db`)}`;
});

describe("KalshiBrokerGateway", () => {
  it("initializes gateway and reports capabilities for event contracts", async () => {
    const gw = getKalshiGateway("test-user");
    const accounts = await gw.getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.capabilities?.eventContracts).toBe(true);
    expect(accounts[0]?.capabilities?.equityTrading).toBe(false);
    expect(accounts[0]?.capabilities?.shortSelling).toBe(false);
  });

  it("reviews event contract orders accurately", async () => {
    const gw = getKalshiGateway("test-user");
    const reviewed = await gw.reviewEquityOrder({
      accountNumber: "kalshi-test",
      symbol: "KXFED-26DEC-T4.50",
      side: "buy",
      type: "limit",
      quantity: 10,
      limitPrice: 0.55,
      timeInForce: "gtc",
      marketHours: "regular_hours"
    });

    expect(reviewed.estimatedNotional).toBe(5.5);
    expect(reviewed.alerts).toEqual([]);
  });

  it("derives known broker limits for kalshi", () => {
    const limits = knownBrokerLimits("kalshi");
    expect(limits.equityTrading).toBe(false);
    expect(limits.optionsTrading).toBe(false);
    expect(limits.shortSelling).toBe(false);
    expect(limits.orderTypes).toContain("limit");
    expect(limits.orderTypes).toContain("market");
  });
});
