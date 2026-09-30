import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// Board 687a5fb4, lane h5.  Production 2026-09-25..29: Alpaca Paper (the owner's Autopilot account)
// was auto-halted at 18:20Z by "Broker health check timed out" and then sat halted, with no runs,
// for four days until an operator re-armed it.  The deploy of #3752 and the weekend restarts ran
// the boot autonomy interlock; with "Auto-resume on boot" off it hands a broker auto-pause to the
// owner exactly as it halts a Running account, and nothing on the console, in the ops snapshot, or
// in the notification title said so.
//
// Pinned here:
//   * auto-halt -> restart -> healthy probe -> resumes, whenever the owner's boot setting (or the
//     AUTONOMY_RESUME_ON_BOOT=1 override) lets autonomy survive a restart;
//   * manual halt -> restart -> healthy probe -> stays halted, with the setting on or off;
//   * autoResumeOnBoot off: a restart halts Running accounts and ends a broker auto-pause, by the
//     owner's setting, and every surface now says so (halt cause, notification title, ops snapshot).

const dir = mkdtempSync(join(tmpdir(), "agentic-halt-cause-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.ENCRYPTION_KEY = "a".repeat(64);

type Health = { isHealthy: boolean; reason?: string; category?: "connectivity" | "order_capability"; probeTimedOut?: boolean };

async function seedAccount(opts: { autoResumeOnBoot: boolean; systemState: "active" | "halted"; label?: string }) {
  const db = await import("../src/lib/db");
  const userId = `halt-cause-${randomUUID()}`;
  const accountId = `acct-${randomUUID()}`;
  const label = opts.label ?? `Paper ${accountId.slice(-4)}`;
  db.setAutoResumeOnBoot(userId, opts.autoResumeOnBoot);
  db.upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "alpaca",
    environment: "paper",
    accountNumber: `PA-${randomUUID().slice(0, 8)}`,
    label,
    isActive: true
  });
  db.setPolicy({ ...db.getPolicy(userId, accountId), systemState: opts.systemState, additionalSymbols: ["AAPL"] }, userId, accountId);
  return { userId, accountId, label };
}

async function probe(userId: string, accountId: string, health: Health) {
  const { applyBrokerOrderPlacementPause } = await import("../src/lib/broker-health");
  const { getPolicy } = await import("../src/lib/db");
  return applyBrokerOrderPlacementPause({ userId, connectedAccountId: accountId, accountScope: accountId, health, policy: getPolicy(userId, accountId) });
}

/** The exact 2026-09-25 18:20Z shape: the scheduler's probe deadline expiring, three ticks in a row. */
async function autoHaltOnProbeTimeouts(userId: string, accountId: string) {
  const { healthSignalsFromProbeFailure } = await import("../src/lib/broker-health");
  const { withDeadline } = await import("../src/lib/inflight-deadline");
  const expired = await withDeadline(new Promise<never>(() => undefined), 5, "checkBrokerHealth timeout").catch((e: unknown) => e);
  const timeout = healthSignalsFromProbeFailure(expired) as Health;
  expect(timeout.reason).toMatch(/^Broker health check timed out/);
  let last: Awaited<ReturnType<typeof probe>> | undefined;
  for (let i = 0; i < 3; i++) last = await probe(userId, accountId, timeout);
  expect(last?.action).toBe("halted");
}

async function restart() {
  const { reconcileAutonomyOnBoot } = await import("../src/lib/scheduler");
  await reconcileAutonomyOnBoot();
  await new Promise((resolve) => setTimeout(resolve, 0)); // fire-and-forget boot notification
}

async function haltCause(userId: string, accountId: string) {
  const { describeAutonomyHaltCause } = await import("../src/lib/autonomy-halt-cause");
  const { getPolicy } = await import("../src/lib/db");
  const policy = getPolicy(userId, accountId);
  return describeAutonomyHaltCause({ userId, connectedAccountId: accountId, accountNumber: policy.accountNumber, systemState: policy.systemState });
}

async function bootNotifications(userId: string) {
  const { listNotificationEvents } = await import("../src/lib/db");
  return listNotificationEvents(userId, 50).filter((e) => e.type === "autonomy_halted_on_boot");
}

describe("broker auto-pause across restarts (lane h5)", () => {
  // Generous: the first import pulls the whole db/scheduler module graph (slow on a loaded host).
  beforeAll(async () => {
    const { getDb } = await import("../src/lib/db");
    getDb();
    await import("../src/lib/broker-health");
    await import("../src/lib/scheduler");
    await import("../src/lib/autonomy-halt-cause");
  }, 900_000);

  afterEach(() => {
    delete process.env.AUTONOMY_RESUME_ON_BOOT;
  });

  it("auto-halt, restart, healthy probe: resumes when autoResumeOnBoot is on", async () => {
    const { getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const { getPolicy, listAudit } = await import("../src/lib/db");
    const { userId, accountId } = await seedAccount({ autoResumeOnBoot: true, systemState: "active" });
    await autoHaltOnProbeTimeouts(userId, accountId);

    const paused = await haltCause(userId, accountId);
    expect(paused).toMatchObject({ kind: "broker_auto_pause", resumesOnItsOwn: true });
    expect(paused?.summary).toMatch(/starts again by itself/);

    await restart();
    expect(getPolicy(userId, accountId).systemState).toBe("halted");
    expect(getBrokerPlacementPauseMarker(userId, accountId)).toBeDefined();
    expect(await haltCause(userId, accountId)).toMatchObject({ kind: "broker_auto_pause", resumesOnItsOwn: true });
    expect(await bootNotifications(userId)).toHaveLength(0);

    // A second restart (the weekend's several deploys) changes nothing.
    await restart();
    expect(getBrokerPlacementPauseMarker(userId, accountId)).toBeDefined();

    const healthy = await probe(userId, accountId, { isHealthy: true });
    expect(healthy.action).toBe("resumed");
    expect(getPolicy(userId, accountId).systemState).toBe("active");
    expect(await haltCause(userId, accountId)).toBeNull();
    expect(listAudit(100, userId).map((a) => a.kind)).toContain("broker_placement_auto_resumed");
  });

  it("auto-halt, restart, healthy probe: resumes under AUTONOMY_RESUME_ON_BOOT=1 even with the user setting off", async () => {
    const { getPolicy } = await import("../src/lib/db");
    const { userId, accountId } = await seedAccount({ autoResumeOnBoot: false, systemState: "active" });
    await autoHaltOnProbeTimeouts(userId, accountId);
    process.env.AUTONOMY_RESUME_ON_BOOT = "1";

    await restart();
    expect(await haltCause(userId, accountId)).toMatchObject({ kind: "broker_auto_pause" });

    expect((await probe(userId, accountId, { isHealthy: true })).action).toBe("resumed");
    expect(getPolicy(userId, accountId).systemState).toBe("active");
  });

  it("manual halt, restart, healthy probe: stays halted when autoResumeOnBoot is on", async () => {
    const { getPolicy } = await import("../src/lib/db");
    const { userId, accountId } = await seedAccount({ autoResumeOnBoot: true, systemState: "halted" });

    await restart();
    expect((await probe(userId, accountId, { isHealthy: true })).action).toBe("none");
    expect(getPolicy(userId, accountId).systemState).toBe("halted");
    expect(await haltCause(userId, accountId)).toMatchObject({ kind: "stopped", resumesOnItsOwn: false });
  });

  it("owner Pause on top of an auto-pause, restart, healthy probe: stays halted when autoResumeOnBoot is on", async () => {
    const { getBrokerPlacementPauseMarker, releaseBrokerPlacementPauseToOwner } = await import("../src/lib/broker-health");
    const { getPolicy } = await import("../src/lib/db");
    const { userId, accountId } = await seedAccount({ autoResumeOnBoot: true, systemState: "active" });
    await autoHaltOnProbeTimeouts(userId, accountId);
    // The owner-Pause path (/api/strategy/pause, mobile strategy.stop) takes the halt over.
    expect(releaseBrokerPlacementPauseToOwner({ userId, connectedAccountId: accountId, source: "test-owner-pause" })).toBe(true);
    expect(getBrokerPlacementPauseMarker(userId, accountId)).toBeUndefined();

    await restart();
    expect((await probe(userId, accountId, { isHealthy: true })).action).toBe("none");
    expect(getPolicy(userId, accountId).systemState).toBe("halted");
    expect(await haltCause(userId, accountId)).toMatchObject({ kind: "stopped" });
  });

  it("manual halt, restart, healthy probe: stays halted when autoResumeOnBoot is off, and the restart does not claim it", async () => {
    const { getPolicy } = await import("../src/lib/db");
    const { userId, accountId } = await seedAccount({ autoResumeOnBoot: false, systemState: "halted" });

    await restart();
    expect((await probe(userId, accountId, { isHealthy: true })).action).toBe("none");
    expect(getPolicy(userId, accountId).systemState).toBe("halted");
    // Already stopped by a person before the restart: the restart is not its cause.
    expect(await haltCause(userId, accountId)).toMatchObject({ kind: "stopped" });
    expect(await bootNotifications(userId)).toHaveLength(0);
  });

  it("autoResumeOnBoot off: a restart halts a Running account by design, says so, and never lifts it by itself", async () => {
    const { clearBootHaltReceiptIfNotHalted, getBootHaltReceipt } = await import("../src/lib/autonomy-halt-cause");
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { userId, accountId, label } = await seedAccount({ autoResumeOnBoot: false, systemState: "active" });

    await restart();
    expect(getPolicy(userId, accountId).systemState).toBe("halted");
    const cause = await haltCause(userId, accountId);
    expect(cause).toMatchObject({ kind: "restart", from: "active", resumesOnItsOwn: false, autoResumeOnBootNow: false });
    expect(cause?.summary).toMatch(/Stopped by the restart at .+ CT\.  It will not start by itself\./);
    expect(cause?.summary).toMatch(/Auto-resume on boot is off/);
    const notes = await bootNotifications(userId);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe(`Autonomy halted on boot: ${label}`);

    expect((await probe(userId, accountId, { isHealthy: true })).action).toBe("none");
    expect(getPolicy(userId, accountId).systemState).toBe("halted");

    // A second restart while it is still halted keeps the first receipt (no duplicate notification).
    await restart();
    expect(await bootNotifications(userId)).toHaveLength(1);
    expect(getBootHaltReceipt(userId, accountId)).toBeDefined();

    // Re-armed: the scheduler tick drops the receipt, so a later manual stop is not blamed on the restart.
    expect(clearBootHaltReceiptIfNotHalted(userId, accountId, "halted")).toBe(false);
    setPolicy({ ...getPolicy(userId, accountId), systemState: "active" }, userId, accountId);
    expect(clearBootHaltReceiptIfNotHalted(userId, accountId, getPolicy(userId, accountId).systemState)).toBe(true);
    expect(getBootHaltReceipt(userId, accountId)).toBeUndefined();
    setPolicy({ ...getPolicy(userId, accountId), systemState: "halted" }, userId, accountId);
    expect(await haltCause(userId, accountId)).toMatchObject({ kind: "stopped" });
  });

  it("autoResumeOnBoot off: a restart ends a broker auto-pause, and the notification and cause say so honestly", async () => {
    const { getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const { getPolicy } = await import("../src/lib/db");
    const { userId, accountId, label } = await seedAccount({ autoResumeOnBoot: false, systemState: "active", label: "Alpaca Paper h5" });
    await autoHaltOnProbeTimeouts(userId, accountId);

    await restart();
    expect(getBrokerPlacementPauseMarker(userId, accountId)).toBeUndefined();
    const cause = await haltCause(userId, accountId);
    expect(cause).toMatchObject({ kind: "restart", from: "broker_auto_pause", resumesOnItsOwn: false });
    expect(cause?.kind === "restart" ? cause.autoPauseReason : undefined).toMatch(/^Broker health check timed out/);
    expect(cause?.summary).toMatch(/ended that auto-pause, so it will not start by itself when the broker recovers/);

    const notes = await bootNotifications(userId);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe(`Restart ended the broker auto-pause: ${label} stays stopped`);
    expect(notes[0].title).not.toMatch(/kept/i);

    expect((await probe(userId, accountId, { isHealthy: true })).action).toBe("none");
    expect(getPolicy(userId, accountId).systemState).toBe("halted");
  });

  it("the ops snapshot shows each user's boot setting and each halted account's cause", async () => {
    const { buildOpsSnapshot } = await import("../src/lib/ops-snapshot");
    const off = await seedAccount({ autoResumeOnBoot: false, systemState: "active" });
    await restart();
    const on = await seedAccount({ autoResumeOnBoot: true, systemState: "active" });
    await autoHaltOnProbeTimeouts(on.userId, on.accountId);

    const snapshot = buildOpsSnapshot({ runsPerUser: 1, auditPerUser: 1 });
    const offUser = snapshot.users.find((u) => u.userId === off.userId);
    const onUser = snapshot.users.find((u) => u.userId === on.userId);
    expect(offUser?.autoResumeOnBoot).toBe(false);
    expect(onUser?.autoResumeOnBoot).toBe(true);
    expect(offUser?.accounts.find((a) => a.connectedAccountId === off.accountId)?.haltCause).toMatchObject({ kind: "restart", from: "active" });
    expect(onUser?.accounts.find((a) => a.connectedAccountId === on.accountId)?.haltCause).toMatchObject({ kind: "broker_auto_pause", resumesOnItsOwn: true });
  });

  it("an ops re-arm answer says why the account was halted", async () => {
    const { describeNextEligibleRun } = await import("../src/lib/ops-account-control");
    const { getConnectedAccount, getPolicy } = await import("../src/lib/db");
    const { userId, accountId } = await seedAccount({ autoResumeOnBoot: false, systemState: "active" });
    await restart();
    const account = getConnectedAccount(accountId, userId);
    expect(account).toBeDefined();
    const run = describeNextEligibleRun({ userId, account: account!, policy: getPolicy(userId, accountId) });
    expect(run.notes.join(" ")).toMatch(/Why halted: Stopped by the restart/);
  });
});

describe("console run-state display of the halt cause (lane h5)", () => {
  it("folds the cause into the chip without changing the shared run-state word", async () => {
    const { deriveStateInfo, withHaltCause } = await import("../app/console/lib/derive");
    const halted = deriveStateInfo({ systemState: "halted", strategyAuthority: "decide" });

    const auto = withHaltCause(halted, { kind: "broker_auto_pause", resumesOnItsOwn: true, since: "2026-09-25T18:20:24Z", reason: "x", summary: "Paused by the app." });
    expect(auto).toMatchObject({ word: "Stopped", label: "Stopped · auto-paused", tone: "warn", cause: "Paused by the app." });

    const boot = withHaltCause(halted, {
      kind: "restart",
      resumesOnItsOwn: false,
      at: "2026-09-26T00:40:00Z",
      from: "broker_auto_pause",
      autoResumeOnBootNow: false,
      summary: "Stopped by the restart."
    });
    expect(boot).toMatchObject({ word: "Stopped", label: "Stopped · by restart", tone: "neg", cause: "Stopped by the restart." });

    expect(withHaltCause(halted, null)).toEqual(halted);
    const running = deriveStateInfo({ systemState: "active", strategyAuthority: "decide" });
    expect(withHaltCause(running, { kind: "stopped", resumesOnItsOwn: false, summary: "stale" })).toEqual(running);
  });
});
