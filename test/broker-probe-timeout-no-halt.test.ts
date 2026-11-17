import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { backdateConnectivityStreak } from "./helpers/connectivity-streak";

// ST-4636.  Production 2026-11-16 (7:10pm, 9:12pm and 12:08am CT): the Tradier sandbox account was
// auto-halted three times with "Tradier order capability probe timed out: The operation was
// aborted due to timeout", and each time the next healthy probe auto-resumed it about 2 minutes
// later.  The order-capability probe returned the timeout as a plain { ok: false }, which
// checkBrokerHealth labelled `order_capability`, so it skipped the connectivity streak gate.
//
// Covered here:
//   * one probe timeout, even read again from the gateway's failure cache, does not halt;
//   * a network-layer probe failure does not halt on the first one either;
//   * repeated timeouts spanning the halt window do halt;
//   * a probe timeout during an event-loop stall is blamed on the app, not counted;
//   * an auth failure on the probe still halts on the first one.

const dir = mkdtempSync(join(tmpdir(), "agentic-probe-timeout-no-halt-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.ENCRYPTION_KEY = "a".repeat(64);

const ACCOUNT = {
  id: "conn-tradier-probe",
  broker: "alpaca" as const,
  environment: "paper" as const,
  accountNumber: "VA-PROBE",
  label: "Sandbox",
  capabilities: undefined
};

type ProbeResult = { ok: boolean; reason?: string; transientFailure?: "timeout" | "network" };

function gatewayWithProbe(probe: () => Promise<ProbeResult>) {
  return {
    getAccounts: async () => [{ accountNumber: ACCOUNT.accountNumber, agenticAllowed: true }],
    getPortfolio: async () => ({
      accountNumber: ACCOUNT.accountNumber,
      totalMarketValue: 50_000,
      buyingPower: 50_000,
      equityMarketValue: 0,
      optionMarketValue: 0,
      cash: 50_000
    }),
    probeOrderCapability: probe
  } as never;
}

const TIMEOUT: ProbeResult = {
  ok: false,
  reason: "Tradier order capability probe timed out: The operation was aborted due to timeout",
  transientFailure: "timeout"
};

async function freshActivePolicy(userId: string) {
  const { getPolicy, setPolicy } = await import("../src/lib/db");
  const policy = getPolicy(userId);
  policy.systemState = "active";
  setPolicy(policy, userId);
  return getPolicy(userId);
}

describe("order-capability probe timeouts do not halt on the first strike (ST-4636)", () => {
  beforeAll(async () => {
    const { getDb } = await import("../src/lib/db");
    getDb();
    await import("../src/lib/broker-health");
  }, 240_000);

  beforeEach(async () => {
    const { getDb } = await import("../src/lib/db");
    getDb().exec("DELETE FROM settings; DELETE FROM audit_events; DELETE FROM strategy_runs;");
    const lag = await import("../src/lib/event-loop-lag");
    lag._resetEventLoopLagForTest();
  });

  it("maps a timed-out probe to a streak-eligible connectivity failure, not order_capability", async () => {
    const { checkBrokerHealth } = await import("../src/lib/broker-health");
    const health = await checkBrokerHealth("local", ACCOUNT, gatewayWithProbe(async () => TIMEOUT));
    expect(health).toEqual({ isHealthy: false, reason: TIMEOUT.reason, category: "connectivity", probeTimedOut: true });
  });

  it("one timeout read on every tick of its 2-minute cache does not halt the account", async () => {
    const { applyBrokerOrderPlacementPause, checkBrokerHealth, getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const { getPolicy, listAudit } = await import("../src/lib/db");
    const userId = "local";
    const accountScope = `acct-cached-${randomUUID()}`;
    const policy = await freshActivePolicy(userId);
    const gateway = gatewayWithProbe(async () => TIMEOUT);
    // Five ticks, more than the 3-count streak: the old gate would have halted on the first.
    for (let i = 0; i < 5; i++) {
      const health = await checkBrokerHealth(userId, ACCOUNT, gateway);
      expect(health.isHealthy).toBe(false);
      const result = await applyBrokerOrderPlacementPause({ userId, accountScope, health, policy });
      expect(result.action).toBe("none");
    }
    expect(getPolicy(userId).systemState).toBe("active");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
    expect(listAudit(50, userId).map((a) => a.kind)).not.toContain("broker_placement_auto_halted");
  });

  it("a network-layer probe failure is streak-gated too", async () => {
    const { applyBrokerOrderPlacementPause, checkBrokerHealth } = await import("../src/lib/broker-health");
    const { getPolicy } = await import("../src/lib/db");
    const userId = "local";
    const accountScope = `acct-network-${randomUUID()}`;
    const policy = await freshActivePolicy(userId);
    const health = await checkBrokerHealth(
      userId,
      ACCOUNT,
      gatewayWithProbe(async () => ({ ok: false, reason: "Tradier order capability probe failed (network): fetch failed", transientFailure: "network" }))
    );
    expect(health).toMatchObject({ isHealthy: false, category: "connectivity", transientConnectivity: true });
    expect((await applyBrokerOrderPlacementPause({ userId, accountScope, health, policy })).action).toBe("none");
    expect(getPolicy(userId).systemState).toBe("active");
  });

  it("repeated timeouts that span the halt window do halt, and a healthy probe resumes", async () => {
    const { applyBrokerOrderPlacementPause, checkBrokerHealth, BROKER_CONNECTIVITY_HALT_STREAK } = await import("../src/lib/broker-health");
    const { getPolicy, listAudit } = await import("../src/lib/db");
    const userId = "local";
    const accountScope = `acct-sustained-${randomUUID()}`;
    const policy = await freshActivePolicy(userId);
    const gateway = gatewayWithProbe(async () => TIMEOUT);
    await backdateConnectivityStreak(userId, accountScope);
    for (let i = 1; i < BROKER_CONNECTIVITY_HALT_STREAK; i++) {
      const health = await checkBrokerHealth(userId, ACCOUNT, gateway);
      expect((await applyBrokerOrderPlacementPause({ userId, accountScope, health, policy })).action).toBe("none");
    }
    const health = await checkBrokerHealth(userId, ACCOUNT, gateway);
    expect((await applyBrokerOrderPlacementPause({ userId, accountScope, health, policy })).action).toBe("halted");
    expect(getPolicy(userId).systemState).toBe("halted");
    const haltRow = listAudit(50, userId).find((a) => a.kind === "broker_placement_auto_halted");
    expect(haltRow?.payload).toMatchObject({ category: "connectivity", probeTimedOut: true, streak: BROKER_CONNECTIVITY_HALT_STREAK });

    const healthy = await checkBrokerHealth(userId, ACCOUNT, gatewayWithProbe(async () => ({ ok: true })));
    expect((await applyBrokerOrderPlacementPause({ userId, accountScope, health: healthy, policy })).action).toBe("resumed");
    expect(getPolicy(userId).systemState).toBe("active");
  });

  it("needs both the count and the span: three failures inside the window do not halt, a later one does", async () => {
    const { recordBrokerConnectivityFailure, BROKER_CONNECTIVITY_HALT_MIN_SPAN_MS } = await import("../src/lib/broker-health");
    const userId = "local";
    const accountScope = `acct-span-${randomUUID()}`;
    const t0 = Date.parse("2026-11-16T06:08:00.000Z");
    expect(recordBrokerConnectivityFailure(userId, accountScope, t0).shouldHalt).toBe(false);
    expect(recordBrokerConnectivityFailure(userId, accountScope, t0 + 60_000).shouldHalt).toBe(false);
    const third = recordBrokerConnectivityFailure(userId, accountScope, t0 + 120_000);
    expect(third).toEqual({ streak: 3, spanMs: 120_000, shouldHalt: false });
    const later = recordBrokerConnectivityFailure(userId, accountScope, t0 + BROKER_CONNECTIVITY_HALT_MIN_SPAN_MS);
    expect(later).toEqual({ streak: 4, spanMs: BROKER_CONNECTIVITY_HALT_MIN_SPAN_MS, shouldHalt: true });
  });

  it("a probe timeout while the event loop was stalled is blamed on the app and never counted", async () => {
    const { applyBrokerOrderPlacementPause, brokerConnectivityStreakKey, checkBrokerHealth } = await import("../src/lib/broker-health");
    const { getInternalSetting, getPolicy } = await import("../src/lib/db");
    const lag = await import("../src/lib/event-loop-lag");
    const userId = "local";
    const accountScope = `acct-stall-${randomUUID()}`;
    const policy = await freshActivePolicy(userId);
    const health = await checkBrokerHealth(
      userId,
      ACCOUNT,
      gatewayWithProbe(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        lag._recordEventLoopLagForTest(Date.now(), 60_000);
        return TIMEOUT;
      })
    );
    expect(health.processStall).toBeDefined();
    expect(health.reason).toMatch(/broker not at fault$/);
    expect((await applyBrokerOrderPlacementPause({ userId, accountScope, health, policy })).action).toBe("none");
    expect(getInternalSetting(brokerConnectivityStreakKey(userId, accountScope))).toBeUndefined();
    expect(getPolicy(userId).systemState).toBe("active");
  });

  it("an auth failure on the probe still halts on the first one", async () => {
    const { applyBrokerOrderPlacementPause, checkBrokerHealth } = await import("../src/lib/broker-health");
    const { getPolicy } = await import("../src/lib/db");
    const userId = "local";
    const accountScope = `acct-auth-${randomUUID()}`;
    const policy = await freshActivePolicy(userId);
    const health = await checkBrokerHealth(
      userId,
      ACCOUNT,
      gatewayWithProbe(async () => ({ ok: false, reason: "Tradier order capability probe failed: Tradier HTTP 401: Invalid access token" }))
    );
    expect(health).toMatchObject({ isHealthy: false, category: "order_capability" });
    expect(health.probeTimedOut).toBeUndefined();
    expect((await applyBrokerOrderPlacementPause({ userId, accountScope, health, policy })).action).toBe("halted");
    expect(getPolicy(userId).systemState).toBe("halted");
  });
});
