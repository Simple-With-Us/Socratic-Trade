// Y — getBrokerGateway wraps placeEquityOrder with the live pre-flight guard, so every real-order
// path (strategy, synthetic stops, protective stops, order replacement, future callers) is covered by
// one shared wrapper. cancelEquityOrder is deliberately NOT guarded (risk-reducing cancels must keep
// working when live trading is disabled — see order-replacement / protective-stops for the
// cancel-and-replace workflows that guard before their own cancel phase).
//
// The LLM-budget choke point is exercised end-to-end in test/strategy-money-path-f-g.test.ts (it now
// gates LLM generation AFTER the non-LLM risk breakers, so a full run is needed to reach it).
// Temp SQLite per run per CLAUDE.md convention; no network (the guard throws before any broker call).
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-choke-${randomUUID()}.db`)}`;
  delete process.env.ALLOW_LIVE_TRADING;
});
afterEach(() => {
  delete process.env.ALLOW_LIVE_TRADING;
});

describe("Y — getBrokerGateway guards every real-order path", () => {
  it("blocks a broker/live placeEquityOrder when ALLOW_LIVE_TRADING is unset", async () => {
    const { upsertConnectedAccount } = await import("../src/lib/db");
    const acctId = "acct-live-1";
    upsertConnectedAccount({
      id: acctId,
      userId: "local",
      broker: "robinhood",
      environment: "live",
      accountNumber: "LIVE-1",
      label: "Live",
      isActive: true
    });

    const { getBrokerGateway } = await import("../src/lib/broker");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const policy = {
      ...DEFAULT_POLICY,
      activeBroker: "robinhood" as const,
      connectedAccountId: acctId,
      accountNumber: "LIVE-1"
    };

    const gateway = getBrokerGateway(policy, "local");
    // The guard throws BEFORE any Robinhood MCP call — no network, no real order. Assert on the
    // pre-flight block message + error name (robust across module boundaries).
    await expect(
      gateway.placeEquityOrder({ accountNumber: "LIVE-1", symbol: "AAPL", side: "buy", type: "market", quantity: 1, timeInForce: "gtc", marketHours: "regular_hours", refId: "guard-1" })
    ).rejects.toThrow(/pre-flight BLOCKED/i);
    await expect(
      gateway.placeEquityOrder({ accountNumber: "LIVE-1", symbol: "AAPL", side: "buy", type: "market", quantity: 1, timeInForce: "gtc", marketHours: "regular_hours", refId: "guard-2" })
    ).rejects.toMatchObject({ name: "LivePreflightError" });
  });

  it("does NOT block a standalone cancel (risk-reducing) — cancels must work even with live trading off", async () => {
    // A cancel reaching the underlying test gateway may reject for its own reasons (unknown order),
    // but it must NEVER be blocked by the live pre-flight guard — the operator must be able to cancel.
    const { upsertConnectedAccount } = await import("../src/lib/db");
    const acctId = "acct-live-2";
    upsertConnectedAccount({ id: acctId, userId: "local", broker: "robinhood", environment: "live", accountNumber: "LIVE-2", label: "Live", isActive: true });
    const { getBrokerGateway } = await import("../src/lib/broker");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const policy = { ...DEFAULT_POLICY, activeBroker: "robinhood" as const, connectedAccountId: acctId, accountNumber: "LIVE-2" };
    const gateway = getBrokerGateway(policy, "local");
    await gateway.cancelEquityOrder("LIVE-2", "order-xyz").catch((e: unknown) => {
      expect(String((e as Error)?.message ?? "")).not.toMatch(/pre-flight BLOCKED/i);
    });
  });
});
