import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
const originalEnv = { DATABASE_URL: process.env.DATABASE_URL, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY };
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.ENCRYPTION_KEY = "a".repeat(64);

afterAll(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const ACCOUNT = {
  id: "conn-tradier-probe",
  broker: "alpaca" as const,
  environment: "paper" as const,
  accountNumber: "VA-PROBE",
  label: "Sandbox",
  capabilities: undefined
};

type ProbeResult = { ok: boolean; reason?: string; transientFailure?: "timeout" | "network"; cached?: true };

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
    expect(third).toEqual({ streak: 3, spanMs: 120_000, shouldHalt: false, restarted: false });
    // Failures keep arriving every two minutes (inside the 5-minute gap), so the streak holds.
    for (const minute of [4, 6, 8]) {
      expect(recordBrokerConnectivityFailure(userId, accountScope, t0 + minute * 60_000).shouldHalt).toBe(false);
    }
    const later = recordBrokerConnectivityFailure(userId, accountScope, t0 + BROKER_CONNECTIVITY_HALT_MIN_SPAN_MS);
    expect(later).toEqual({ streak: 7, spanMs: BROKER_CONNECTIVITY_HALT_MIN_SPAN_MS, shouldHalt: true, restarted: false });
  });

  it("an old isolated failure does not combine with a later one after a long gap (Sentry)", async () => {
    const { recordBrokerConnectivityFailure, BROKER_CONNECTIVITY_STREAK_MAX_GAP_MS } = await import("../src/lib/broker-health");
    const userId = "local";
    const accountScope = `acct-gap-${randomUUID()}`;
    const t0 = Date.parse("2026-11-16T06:08:00.000Z");
    recordBrokerConnectivityFailure(userId, accountScope, t0);
    recordBrokerConnectivityFailure(userId, accountScope, t0 + 60_000);
    // Hours of other unhealthy answers (5xx, stall) never touched the streak; then two timeouts.
    const later = t0 + 3 * 60 * 60_000;
    expect(recordBrokerConnectivityFailure(userId, accountScope, later)).toMatchObject({ streak: 1, spanMs: 0, restarted: true });
    expect(recordBrokerConnectivityFailure(userId, accountScope, later + BROKER_CONNECTIVITY_STREAK_MAX_GAP_MS))
      .toMatchObject({ streak: 2, shouldHalt: false, restarted: false });
  });

  it("cached probe answers keep a streak alive but never add to it or halt (Sentry)", async () => {
    const { recordBrokerConnectivityFailure, BROKER_CONNECTIVITY_HALT_MIN_SPAN_MS } = await import("../src/lib/broker-health");
    const userId = "local";
    const accountScope = `acct-cached-count-${randomUUID()}`;
    const t0 = Date.parse("2026-11-16T06:08:00.000Z");
    // No streak yet: a cached answer starts nothing.
    expect(recordBrokerConnectivityFailure(userId, accountScope, t0, { countable: false }))
      .toEqual({ streak: 0, spanMs: 0, shouldHalt: false, restarted: false });
    recordBrokerConnectivityFailure(userId, accountScope, t0);
    // Every minute for 12 minutes, cached: count stays at 1, the 4-minute gaps never expire it.
    for (let minute = 1; minute <= 12; minute++) {
      const tick = recordBrokerConnectivityFailure(userId, accountScope, t0 + minute * 60_000, { countable: false });
      expect(tick).toMatchObject({ streak: 1, shouldHalt: false, restarted: false });
    }
    // Fresh answers still need the count: 2 and 3 fresh failures past the span.
    expect(recordBrokerConnectivityFailure(userId, accountScope, t0 + 13 * 60_000).shouldHalt).toBe(false);
    expect(recordBrokerConnectivityFailure(userId, accountScope, t0 + 14 * 60_000))
      .toMatchObject({ streak: 3, spanMs: 14 * 60_000, shouldHalt: true });
    expect(14 * 60_000).toBeGreaterThanOrEqual(BROKER_CONNECTIVITY_HALT_MIN_SPAN_MS);
  });

  it("a cached probe timeout skips the tick without counting, even after a stall (Sentry)", async () => {
    const { applyBrokerOrderPlacementPause, brokerConnectivityStreakKey, checkBrokerHealth } = await import("../src/lib/broker-health");
    const { getInternalSetting, getPolicy } = await import("../src/lib/db");
    const userId = "local";
    const accountScope = `acct-cached-stall-${randomUUID()}`;
    const policy = await freshActivePolicy(userId);
    const gateway = gatewayWithProbe(async () => ({ ...TIMEOUT, cached: true }));
    for (let i = 0; i < 5; i++) {
      const health = await checkBrokerHealth(userId, ACCOUNT, gateway);
      expect(health).toEqual({
        isHealthy: false,
        reason: TIMEOUT.reason,
        category: "connectivity",
        probeTimedOut: true,
        probeResultCached: true
      });
      expect((await applyBrokerOrderPlacementPause({ userId, accountScope, health, policy })).action).toBe("none");
    }
    expect(getInternalSetting(brokerConnectivityStreakKey(userId, accountScope))).toBeUndefined();
    expect(getPolicy(userId).systemState).toBe("active");
  });

  it("a sub-threshold connectivity skip writes one strategy_runs row per episode (Kody)", async () => {
    const { checkBrokerHealth, processStallHealthSignals, shouldPersistBrokerHealthSkip } = await import("../src/lib/broker-health");
    const health = await checkBrokerHealth("local", ACCOUNT, gatewayWithProbe(async () => TIMEOUT));
    expect(shouldPersistBrokerHealthSkip({ wasActive: true, pauseAction: "none", health, skipEpisodeStarted: true })).toBe(true);
    expect(shouldPersistBrokerHealthSkip({ wasActive: true, pauseAction: "none", health, skipEpisodeStarted: false })).toBe(false);
    const network = { isHealthy: false, reason: "fetch failed", category: "connectivity" as const, transientConnectivity: true };
    expect(shouldPersistBrokerHealthSkip({ wasActive: true, pauseAction: "none", health: network, skipEpisodeStarted: true })).toBe(true);
    // A process stall changes its reason every tick and is not the broker's fault: no row.
    expect(shouldPersistBrokerHealthSkip({
      wasActive: true,
      pauseAction: "none",
      health: processStallHealthSignals(9_000, 10_000),
      skipEpisodeStarted: true
    })).toBe(false);
    expect(shouldPersistBrokerHealthSkip({ wasActive: false, pauseAction: "none", health, skipEpisodeStarted: true })).toBe(false);
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
