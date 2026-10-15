import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "broker-health-pause-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.ENCRYPTION_KEY = "a".repeat(64);

describe("broker-health auto-pause when orders cannot be placed", () => {
  beforeAll(async () => {
    const { getDb } = await import("../src/lib/db");
    getDb(); // migrate
  });

  beforeEach(async () => {
    const { getDb } = await import("../src/lib/db");
    getDb().exec("DELETE FROM settings; DELETE FROM audit_events; DELETE FROM strategy_runs;");
    // Outside the 16-minute sandbox window so Tradier paper probes are not skipped.
    const { setTradierNowForTests } = await import("../src/lib/tradier-transient");
    setTradierNowForTests(() => new Date("2026-10-14T19:00:00.000Z"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { setTradierNowForTests } = await import("../src/lib/tradier-transient");
    setTradierNowForTests(null);
  });

  it("classifies infrastructure place failures vs ordinary rejects", async () => {
    const { isOrderPlacementInfrastructureFailure } = await import("../src/lib/broker-health");
    expect(isOrderPlacementInfrastructureFailure("Tradier HTTP 500: An error occurred while communicating with the backend.")).toBe(true);
    expect(isOrderPlacementInfrastructureFailure('{"errors":["An unexpected error occurred. Please try again."]}')).toBe(true);
    expect(isOrderPlacementInfrastructureFailure("fetch failed")).toBe(true);
    expect(isOrderPlacementInfrastructureFailure("ECONNRESET")).toBe(true);
    expect(isOrderPlacementInfrastructureFailure("alpaca 403: insufficient buying power")).toBe(false);
    expect(isOrderPlacementInfrastructureFailure("You do not have enough buying power for this trade.")).toBe(false);
    expect(isOrderPlacementInfrastructureFailure("OrderValidationError: qty < 1")).toBe(false);
    expect(isOrderPlacementInfrastructureFailure("Tradier HTTP 400: Unexpected server error")).toBe(false);
    expect(isOrderPlacementInfrastructureFailure("Tradier order failed: Tradier HTTP 400: Unexpected server error")).toBe(false);
    expect(isOrderPlacementInfrastructureFailure("Tradier HTTP 422: Unexpected server error")).toBe(false);
    expect(
      isOrderPlacementInfrastructureFailure(
        "Tradier sandbox quotes are 15 minutes delayed, so strategy runs and order placement wait until 16 minutes after the open (9:46am ET).  Safe to retry."
      )
    ).toBe(false);
    expect(
      isOrderPlacementInfrastructureFailure(
        "Tradier sandbox order placement is deferred until 15 minutes after the open. Safe to retry."
      )
    ).toBe(false);
    expect(isOrderPlacementInfrastructureFailure("Tradier HTTP 500: Unexpected server error")).toBe(true);
    expect(isOrderPlacementInfrastructureFailure("HTTP 403 Forbidden")).toBe(false);
  });

  it("halts active policy when health is unhealthy and auto-resumes when healthy", async () => {
    const { getPolicy, setPolicy, listAudit } = await import("../src/lib/db");
    const {
      applyBrokerOrderPlacementPause,
      getBrokerPlacementPauseMarker,
      clearBrokerPlacementPauseMarker
    } = await import("../src/lib/broker-health");

    const userId = "local";
    const accountScope = "acct-test-1";
    const policy = getPolicy(userId);
    policy.systemState = "active";
    setPolicy(policy, userId);

    const halt = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: {
        isHealthy: false,
        reason: "Tradier order path unavailable: HTTP 500 backend",
        category: "order_capability"
      },
      policy
    });
    expect(halt.action).toBe("halted");
    expect(getPolicy(userId).systemState).toBe("halted");
    const marker = getBrokerPlacementPauseMarker(userId, accountScope);
    expect(marker?.autoResume).toBe(true);
    expect(marker?.reason).toMatch(/Tradier order path/);

    // Still unhealthy → still paused, no double-flip noise
    policy.systemState = "halted";
    const still = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: false, reason: "still down", category: "order_capability" },
      policy
    });
    expect(still.action).toBe("still_paused");
    if (still.action === "still_paused") {
      expect(still.autoOwned).toBe(true);
    }

    // Healthy again → auto-resume
    const resume = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: true },
      policy
    });
    expect(resume.action).toBe("resumed");
    expect(getPolicy(userId).systemState).toBe("active");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();

    const kinds = listAudit(50, userId).map((a) => a.kind);
    expect(kinds).toContain("broker_placement_auto_halted");
    expect(kinds).toContain("broker_placement_auto_resumed");

    clearBrokerPlacementPauseMarker(userId, accountScope);
  });

  it("does not auto-resume an owner halt that has no placement-pause marker", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { applyBrokerOrderPlacementPause, getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");

    const userId = "local";
    const accountScope = "acct-owner-halt";
    const policy = getPolicy(userId);
    policy.systemState = "halted"; // owner stopped
    setPolicy(policy, userId);

    const result = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: true },
      policy
    });
    expect(result.action).toBe("none");
    expect(getPolicy(userId).systemState).toBe("halted");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
  });

  it("does not claim ownership of halt when already halted without our marker", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { applyBrokerOrderPlacementPause, getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");

    const userId = "local";
    const accountScope = "acct-owner-halt-2";
    const policy = getPolicy(userId);
    policy.systemState = "halted";
    setPolicy(policy, userId);

    const result = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: false, reason: "OMS down", category: "order_capability" },
      policy
    });
    // already halted by owner — we report still_paused but do NOT write our auto-resume marker
    expect(result.action).toBe("still_paused");
    if (result.action === "still_paused") {
      expect(result.autoOwned).toBe(false);
    }
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
  });

  // The scheduler reads its policy snapshot, then awaits checkBrokerHealth (up to ~30s) before
  // calling applyBrokerOrderPlacementPause.  An operator (console Start/Stop, ops account-control)
  // can change systemState during that await; the decision and the write must use durable state.
  it("an operator halt or close_only made during the health probe is not converted into an auto-resumable halt", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { applyBrokerOrderPlacementPause, getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const userId = "local";
    const accountScope = "acct-race-operator-state";
    for (const operatorState of ["halted", "close_only"] as const) {
      setPolicy({ ...getPolicy(userId), systemState: "active" }, userId);
      const snapshot = getPolicy(userId); // the tick's read, before the probe
      setPolicy({ ...getPolicy(userId), systemState: operatorState }, userId); // operator, during the probe
      const result = await applyBrokerOrderPlacementPause({
        userId,
        accountScope,
        health: { isHealthy: false, reason: "Tradier order path unavailable: HTTP 500 backend", category: "order_capability" },
        policy: snapshot
      });
      expect(result.action).not.toBe("halted");
      expect(getPolicy(userId).systemState).toBe(operatorState);
      expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
    }
  });

  it("an operator close_only made during the probe of an auto-halted account is not resumed to active", async () => {
    const { getPolicy, setPolicy, setInternalSetting } = await import("../src/lib/db");
    const { applyBrokerOrderPlacementPause, getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const userId = "local";
    const accountScope = "acct-race-close-only";
    setPolicy({ ...getPolicy(userId), systemState: "halted" }, userId);
    setInternalSetting(`broker:placement-paused:${userId}:${accountScope}`, {
      since: new Date().toISOString(),
      reason: "Tradier order capability probe failed",
      autoResume: true,
      priorState: "active"
    });
    const snapshot = getPolicy(userId); // halted, read before the probe
    setPolicy({ ...getPolicy(userId), systemState: "close_only" }, userId); // operator, during the probe

    const result = await applyBrokerOrderPlacementPause({ userId, accountScope, health: { isHealthy: true }, policy: snapshot });
    expect(result.action).toBe("none");
    expect(getPolicy(userId).systemState).toBe("close_only");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
  });

  it("a healthy probe leaves an operator halt made mid-probe alone and never writes the stale snapshot", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { applyBrokerOrderPlacementPause } = await import("../src/lib/broker-health");
    const userId = "local";
    setPolicy({ ...getPolicy(userId), systemState: "active" }, userId);
    const snapshot = getPolicy(userId);
    setPolicy({ ...getPolicy(userId), systemState: "halted" }, userId);
    const result = await applyBrokerOrderPlacementPause({ userId, accountScope: "acct-race-healthy", health: { isHealthy: true }, policy: snapshot });
    expect(result.action).toBe("none");
    expect(getPolicy(userId).systemState).toBe("halted");
  });

  it("does nothing for an account removed during the probe instead of flipping the user-level policy", async () => {
    const { getPolicy, setPolicy, upsertConnectedAccount, purgeConnectedAccount, getDb } = await import("../src/lib/db");
    const { applyBrokerOrderPlacementPause, getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const userId = `pause-removed-${Date.now()}`;
    const accountId = `acct-removed-${Date.now()}`;
    upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "tradier",
      environment: "paper",
      accountNumber: "VAREMOVED1",
      label: "Tradier Sandbox",
      apiKey: "k",
      isActive: false
    });
    setPolicy({ ...getPolicy(userId, accountId), systemState: "active" }, userId, accountId);
    const snapshot = getPolicy(userId, accountId);
    const userLevelBefore = getDb()
      .prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'policy'")
      .get(userId) as { value: string } | undefined;
    purgeConnectedAccount(accountId, userId); // removed while the probe was in flight

    const result = await applyBrokerOrderPlacementPause({
      userId,
      connectedAccountId: accountId,
      accountScope: accountId,
      health: { isHealthy: false, reason: "Tradier order path unavailable: HTTP 500 backend", category: "order_capability" },
      policy: snapshot
    });
    expect(result.action).toBe("none");
    const userLevelAfter = getDb()
      .prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'policy'")
      .get(userId) as { value: string } | undefined;
    expect(userLevelAfter?.value).toBe(userLevelBefore?.value);
    expect(getBrokerPlacementPauseMarker(userId, accountId)).toBeUndefined();
  });

  it("auto-halt changes only systemState and keeps a console edit made during the probe", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { applyBrokerOrderPlacementPause, clearBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const userId = "local";
    const accountScope = "acct-race-console-edit";
    setPolicy({ ...getPolicy(userId), systemState: "active", runCadenceMinutes: 30 }, userId);
    const snapshot = getPolicy(userId);
    setPolicy({ ...getPolicy(userId), runCadenceMinutes: 17 }, userId); // console edit, during the probe

    const result = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: false, reason: "Tradier order path unavailable: HTTP 500 backend", category: "order_capability" },
      policy: snapshot
    });
    expect(result.action).toBe("halted");
    const after = getPolicy(userId);
    expect(after.systemState).toBe("halted");
    expect(after.runCadenceMinutes).toBe(17);
    expect(snapshot.systemState).toBe("halted");
    clearBrokerPlacementPauseMarker(userId, accountScope);
  });

  it("low equity on an active account skips without auto-halt, marker, or kill_switch", async () => {
    const { getPolicy, setPolicy, listAudit } = await import("../src/lib/db");
    const { applyBrokerOrderPlacementPause, getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const notificationsMod = await import("../src/lib/notifications");
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockImplementation(() => {
      throw new Error("sendNotification should not be called for equity-low health skip");
    });

    const userId = "local";
    const accountScope = "acct-equity-low";
    const policy = getPolicy(userId);
    policy.systemState = "active";
    setPolicy(policy, userId);

    const health = {
      isHealthy: false,
      reason: "Account equity (2.5) is too low to trade",
      category: "equity" as const
    };
    const first = await applyBrokerOrderPlacementPause({ userId, accountScope, health, policy });
    expect(first.action).toBe("none");
    const second = await applyBrokerOrderPlacementPause({ userId, accountScope, health, policy });
    expect(second.action).toBe("none");
    expect(getPolicy(userId).systemState).toBe("active");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();

    const kinds = listAudit(50, userId).map((a) => a.kind);
    expect(kinds).not.toContain("broker_placement_auto_halted");
    expect(sendNotificationSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "kill_switch" }),
      expect.anything()
    );
    sendNotificationSpy.mockRestore();
  });

  it("checkBrokerHealth fails closed when probeOrderCapability returns not ok", async () => {
    const { checkBrokerHealth } = await import("../src/lib/broker-health");
    const gateway = {
      getAccounts: async () => [{ accountNumber: "VA1", label: "Sandbox", agenticAllowed: true }],
      getPortfolio: async () => ({
        accountNumber: "VA1",
        totalMarketValue: 100_000,
        buyingPower: 100_000,
        equityMarketValue: 0,
        optionMarketValue: 0,
        cash: 100_000
      }),
      probeOrderCapability: async () => ({
        ok: false,
        reason: "Tradier order path unavailable: HTTP 500 backend"
      })
    };
    const health = await checkBrokerHealth(
      "local",
      {
        id: "conn-1",
        broker: "tradier",
        environment: "paper",
        accountNumber: "VA1",
        label: "Sandbox",
        capabilities: undefined
      },
      gateway as never
    );
    expect(health.isHealthy).toBe(false);
    expect(health.category).toBe("order_capability");
    expect(health.reason).toMatch(/Tradier order path/);
  });

  it("checkBrokerHealth treats probe ok + funded account as healthy", async () => {
    const { checkBrokerHealth } = await import("../src/lib/broker-health");
    const gateway = {
      getAccounts: async () => [{ accountNumber: "PA1", label: "Paper", agenticAllowed: true }],
      getPortfolio: async () => ({
        accountNumber: "PA1",
        totalMarketValue: 50_000,
        buyingPower: 50_000,
        equityMarketValue: 0,
        optionMarketValue: 0,
        cash: 50_000
      }),
      probeOrderCapability: async () => ({ ok: true })
    };
    const health = await checkBrokerHealth(
      "local",
      {
        id: "conn-2",
        broker: "alpaca",
        environment: "paper",
        accountNumber: "PA1",
        label: "Paper",
        capabilities: undefined
      },
      gateway as never
    );
    expect(health.isHealthy).toBe(true);
  });

  it("persists skipped_broker_unhealthy once when the scheduler gate auto-halts", async () => {
    const { getDb, listAudit } = await import("../src/lib/db");
    const {
      persistBrokerHealthSkipRun,
      shouldPersistBrokerHealthSkip
    } = await import("../src/lib/broker-health");

    expect(shouldPersistBrokerHealthSkip({ wasActive: true, pauseAction: "halted" })).toBe(true);
    expect(shouldPersistBrokerHealthSkip({ wasActive: true, pauseAction: "none" })).toBe(false);
    expect(
      shouldPersistBrokerHealthSkip({
        wasActive: true,
        pauseAction: "none",
        health: { isHealthy: false, category: "equity", reason: "Account equity (0) is too low to trade" },
        skipEpisodeStarted: true
      })
    ).toBe(true);
    expect(
      shouldPersistBrokerHealthSkip({
        wasActive: true,
        pauseAction: "none",
        health: { isHealthy: false, category: "equity", reason: "Account equity (0) is too low to trade" },
        skipEpisodeStarted: false
      })
    ).toBe(false);
    expect(shouldPersistBrokerHealthSkip({ wasActive: false, pauseAction: "halted" })).toBe(false);
    expect(shouldPersistBrokerHealthSkip({ wasActive: true, pauseAction: "still_paused" })).toBe(false);

    const runId = persistBrokerHealthSkipRun({
      userId: "local",
      connectedAccountId: "acct-equity-0",
      accountNumber: "PA1",
      reason: "Account equity (0) is too low to trade",
      halted: false
    });
    const row = getDb()
      .prepare("SELECT status, summary, connected_account_id FROM strategy_runs WHERE id = ?")
      .get(runId) as { status: string; summary: string; connected_account_id: string };
    expect(row.status).toBe("skipped_broker_unhealthy");
    expect(row.connected_account_id).toBe("acct-equity-0");
    expect(row.summary).not.toMatch(/auto-paused/);
    expect(row.summary).toMatch(/equity \(0\)/);
    const kinds = listAudit(50, "local").map((a) => a.kind);
    expect(kinds).toContain("run_skipped_broker_unhealthy");
  });

  it("does not halt, resume, or write skipped_broker_unhealthy for the sandbox sentence", async () => {
    const { getPolicy, setPolicy, listAudit, getInternalSetting } = await import("../src/lib/db");
    const {
      applyBrokerOrderPlacementPause,
      brokerConnectivityStreakKey,
      brokerHealthRunSkip,
      checkBrokerHealth,
      getBrokerPlacementPauseMarker,
      shouldPersistBrokerHealthSkip
    } = await import("../src/lib/broker-health");
    const notificationsMod = await import("../src/lib/notifications");
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockImplementation(() => {
      throw new Error("sendNotification should not be called for a transient Tradier sentence");
    });

    const userId = "local";
    const accountScope = "acct-tradier-transient";
    const policy = getPolicy(userId);
    policy.systemState = "active";
    setPolicy(policy, userId);

    const reason = "Tradier order path unavailable: Tradier HTTP 400: Unexpected server error";
    const health = {
      isHealthy: false,
      reason,
      category: "connectivity" as const,
      transientBrokerError: true
    };
    for (let i = 0; i < 3; i++) {
      const result = await applyBrokerOrderPlacementPause({ userId, accountScope, health, policy });
      expect(result.action).toBe("none");
    }
    expect(getPolicy(userId).systemState).toBe("active");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
    expect(getInternalSetting(brokerConnectivityStreakKey(userId, accountScope))).toBeUndefined();
    const kinds = listAudit(50, userId).map((a) => a.kind);
    expect(kinds).not.toContain("broker_placement_auto_halted");
    expect(kinds).not.toContain("broker_placement_auto_resumed");
    expect(sendNotificationSpy).not.toHaveBeenCalled();

    const skip = brokerHealthRunSkip(health);
    expect(skip.status).toBe("skipped");
    expect(skip.auditKind).toBe("run_skipped_broker_transient");
    expect(skip.summary).toMatch(/Autonomous trading stays armed/);
    expect(
      shouldPersistBrokerHealthSkip({
        wasActive: true,
        pauseAction: "none",
        health,
        skipEpisodeStarted: true
      })
    ).toBe(false);

    const gateway = {
      getAccounts: async () => [{ accountNumber: "VA1", label: "Sandbox", agenticAllowed: true }],
      getPortfolio: async () => ({
        accountNumber: "VA1",
        totalMarketValue: 100_000,
        buyingPower: 100_000,
        equityMarketValue: 0,
        optionMarketValue: 0,
        cash: 100_000
      }),
      probeOrderCapability: async () => ({ ok: false, reason })
    };
    const probed = await checkBrokerHealth(
      userId,
      {
        id: "conn-transient",
        broker: "tradier",
        environment: "paper",
        accountNumber: "VA1",
        label: "Sandbox",
        capabilities: undefined
      },
      gateway as never
    );
    expect(probed.isHealthy).toBe(false);
    expect(probed.category).toBe("connectivity");
    expect(probed.transientBrokerError).toBe(true);
    const fromProbe = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: probed,
      policy
    });
    expect(fromProbe.action).toBe("none");
    expect(getPolicy(userId).systemState).toBe("active");
    sendNotificationSpy.mockRestore();
  });

  it("still halts a real order-path failure and resumes only on a healthy probe", async () => {
    const { getPolicy, setPolicy, listAudit } = await import("../src/lib/db");
    const {
      applyBrokerOrderPlacementPause,
      checkBrokerHealth,
      getBrokerPlacementPauseMarker,
      clearBrokerPlacementPauseMarker
    } = await import("../src/lib/broker-health");

    const userId = "local";
    const accountScope = "acct-tradier-real-reject";
    const policy = getPolicy(userId);
    policy.systemState = "active";
    setPolicy(policy, userId);

    const funded = {
      getAccounts: async () => [{ accountNumber: "VA1", label: "Sandbox", agenticAllowed: true }],
      getPortfolio: async () => ({
        accountNumber: "VA1",
        totalMarketValue: 100_000,
        buyingPower: 100_000,
        equityMarketValue: 0,
        optionMarketValue: 0,
        cash: 100_000
      })
    };
    const badRequest = await checkBrokerHealth(
      userId,
      {
        id: "conn-real",
        broker: "tradier",
        environment: "paper",
        accountNumber: "VA1",
        label: "Sandbox",
        capabilities: undefined
      },
      {
        ...funded,
        probeOrderCapability: async () => ({
          ok: false,
          reason: "Tradier order capability probe failed: Tradier HTTP 400: Bad Request"
        })
      } as never
    );
    expect(badRequest.category).toBe("order_capability");
    expect(badRequest.transientBrokerError).toBeUndefined();
    const halted = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: badRequest,
      policy
    });
    expect(halted.action).toBe("halted");
    expect(getPolicy(userId).systemState).toBe("halted");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)?.autoResume).toBe(true);

    policy.systemState = "halted";
    const duringBlip = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: {
        isHealthy: false,
        reason: "Tradier order path unavailable: Tradier HTTP 400: Unexpected server error",
        category: "connectivity",
        transientBrokerError: true
      },
      policy
    });
    expect(duringBlip.action).toBe("still_paused");
    expect(getPolicy(userId).systemState).toBe("halted");

    const down = await checkBrokerHealth(
      userId,
      {
        id: "conn-real",
        broker: "tradier",
        environment: "paper",
        accountNumber: "VA1",
        label: "Sandbox",
        capabilities: undefined
      },
      {
        ...funded,
        probeOrderCapability: async () => ({
          ok: false,
          reason: "Tradier order path unavailable: Tradier HTTP 500: backend"
        })
      } as never
    );
    expect(down.category).toBe("order_capability");
    expect(down.transientBrokerError).toBeUndefined();

    const resume = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: true },
      policy
    });
    expect(resume.action).toBe("resumed");
    expect(getPolicy(userId).systemState).toBe("active");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
    const kinds = listAudit(50, userId).map((a) => a.kind);
    expect(kinds).toContain("broker_placement_auto_halted");
    expect(kinds).toContain("broker_placement_auto_resumed");
    clearBrokerPlacementPauseMarker(userId, accountScope);
  });

  it("skips a Tradier sandbox strategy run until 9:46am ET and does not halt", async () => {
    const { getPolicy, setPolicy, listAudit, getInternalSetting } = await import("../src/lib/db");
    const {
      applyBrokerOrderPlacementPause,
      brokerConnectivityStreakKey,
      brokerHealthRunSkip,
      checkBrokerHealth,
      getBrokerPlacementPauseMarker,
      shouldPersistBrokerHealthSkip
    } = await import("../src/lib/broker-health");
    const { setTradierNowForTests, TRADIER_SANDBOX_OPEN_DEFERRAL_MESSAGE } = await import("../src/lib/tradier-transient");
    const notificationsMod = await import("../src/lib/notifications");
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockImplementation(() => {
      throw new Error("sendNotification should not be called for a sandbox open deferral");
    });

    const userId = "local";
    const accountScope = "acct-sandbox-open";
    const policy = getPolicy(userId);
    policy.systemState = "active";
    setPolicy(policy, userId);

    setTradierNowForTests(() => new Date("2026-10-14T13:45:00.000Z"));
    const gateway = {
      getAccounts: async () => {
        throw new Error("sandbox open window must not probe the broker");
      },
      getPortfolio: async () => {
        throw new Error("sandbox open window must not probe the broker");
      },
      probeOrderCapability: async () => {
        throw new Error("sandbox open window must not probe the broker");
      }
    };
    const sandboxAccount = {
      id: "conn-sandbox-open",
      broker: "tradier" as const,
      environment: "paper" as const,
      accountNumber: "VA1",
      label: "Sandbox",
      capabilities: undefined
    };
    const health = await checkBrokerHealth(userId, sandboxAccount, gateway as never);
    expect(health.isHealthy).toBe(false);
    expect(health.sandboxOpenDeferral).toBe(true);
    expect(health.reason).toBe(TRADIER_SANDBOX_OPEN_DEFERRAL_MESSAGE);
    const pause = await applyBrokerOrderPlacementPause({ userId, accountScope, health, policy });
    expect(pause.action).toBe("none");
    expect(getPolicy(userId).systemState).toBe("active");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
    expect(getInternalSetting(brokerConnectivityStreakKey(userId, accountScope))).toBeUndefined();
    const skip = brokerHealthRunSkip(health);
    expect(skip.status).toBe("skipped");
    expect(skip.auditKind).toBe("run_skipped_sandbox_open_deferral");
    expect(skip.summary).toMatch(/9:46am ET/);
    expect(skip.summary).not.toMatch(/skipped_broker_unhealthy/);
    expect(
      shouldPersistBrokerHealthSkip({
        wasActive: true,
        pauseAction: pause.action,
        health,
        skipEpisodeStarted: true
      })
    ).toBe(false);
    expect(listAudit(50, userId).map((a) => a.kind)).not.toContain("broker_placement_auto_halted");

    setTradierNowForTests(() => new Date("2026-10-14T13:46:00.000Z"));
    let probed = false;
    const open = await checkBrokerHealth(
      userId,
      sandboxAccount,
      {
        getAccounts: async () => [{ accountNumber: "VA1", label: "Sandbox", agenticAllowed: true }],
        getPortfolio: async () => ({
          accountNumber: "VA1",
          totalMarketValue: 100_000,
          buyingPower: 100_000,
          equityMarketValue: 0,
          optionMarketValue: 0,
          cash: 100_000
        }),
        probeOrderCapability: async () => {
          probed = true;
          return { ok: true };
        }
      } as never
    );
    expect(probed).toBe(true);
    expect(open.isHealthy).toBe(true);
    expect(open.sandboxOpenDeferral).toBeUndefined();

    setTradierNowForTests(() => new Date("2026-10-14T13:35:00.000Z"));
    const live = await checkBrokerHealth(
      userId,
      { ...sandboxAccount, environment: "live", label: "Tradier Brokerage" },
      {
        getAccounts: async () => [{ accountNumber: "VA1", label: "Live", agenticAllowed: true }],
        getPortfolio: async () => ({
          accountNumber: "VA1",
          totalMarketValue: 100_000,
          buyingPower: 100_000,
          equityMarketValue: 0,
          optionMarketValue: 0,
          cash: 100_000
        }),
        probeOrderCapability: async () => ({ ok: true })
      } as never
    );
    expect(live.isHealthy).toBe(true);
    expect(live.sandboxOpenDeferral).toBeUndefined();

    const alpaca = await checkBrokerHealth(
      userId,
      { ...sandboxAccount, broker: "alpaca", accountNumber: "PA1", label: "Alpaca Paper" },
      {
        getAccounts: async () => [{ accountNumber: "PA1", label: "Paper", agenticAllowed: true }],
        getPortfolio: async () => ({
          accountNumber: "PA1",
          totalMarketValue: 100_000,
          buyingPower: 100_000,
          equityMarketValue: 0,
          optionMarketValue: 0,
          cash: 100_000
        }),
        probeOrderCapability: async () => ({ ok: true })
      } as never
    );
    expect(alpaca.isHealthy).toBe(true);
    expect(alpaca.sandboxOpenDeferral).toBeUndefined();
    expect(sendNotificationSpy).not.toHaveBeenCalled();
    sendNotificationSpy.mockRestore();
  });
});
