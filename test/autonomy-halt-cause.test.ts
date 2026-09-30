import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// Board 687a5fb4, lane h5.  Production 2026-09-25..29: Alpaca Paper (the owner's Autopilot account)
// was auto-halted at 18:20Z by "Broker health check timed out" and then sat halted, with no runs,
// for four days until an operator re-armed it.  Why the auto-pause never lifted is a hypothesis, not
// established (rollout note, Review round).  Leading candidate: pre-#3752 apply decided on the
// caller's snapshot, so a tick or run that read "active" before the halt and then got a healthy
// probe dropped the auto-resume marker without resuming.  #3752's durable re-read closed that; the
// first test below pins it.  Alternative: the boot interlock ended the auto-pause at the #3752
// deploy because "Auto-resume on boot" was off.
//
// Pinned here:
//   * stale "active" caller snapshot + durable auto-halt + healthy probe -> resumes (the pre-#3752 hole);
//   * auto-halt -> restart -> healthy probe -> resumes, whenever the owner's boot setting (or the
//     AUTONOMY_RESUME_ON_BOOT=1 override) lets autonomy survive a restart;
//   * manual halt -> restart -> healthy probe -> stays halted, with the setting on or off;
//   * autoResumeOnBoot off: a restart halts Running accounts and ends a broker auto-pause, by the
//     owner's setting, and every surface says so (halt cause, notifications, ops snapshot);
//   * every halted account names its cause: auto-pause (with the last failed probe), restart,
//     drawdown breaker, auto-pause whose resume record is gone, or "no record" (never "a person").

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
  it("pre-#3752 hole: durable auto-halt + a caller snapshot still 'active' + healthy probe resumes and clears the marker", async () => {
    const { applyBrokerOrderPlacementPause, getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const { getPolicy, listAudit } = await import("../src/lib/db");
    const { userId, accountId } = await seedAccount({ autoResumeOnBoot: true, systemState: "active" });
    // A scheduled run (or an overlapping tick) read its policy while the account was Running...
    const staleSnapshot = getPolicy(userId, accountId);
    // ...then the scheduler gate auto-halted the account (the 18:20Z shape)...
    await autoHaltOnProbeTimeouts(userId, accountId);
    expect(getBrokerPlacementPauseMarker(userId, accountId)).toBeDefined();
    expect(staleSnapshot.systemState).toBe("active");

    // ...and that caller's own probe came back healthy.  Pre-#3752 code read `policy.systemState`
    // ("active"), took the "owner already re-armed" branch, dropped the marker and left the account
    // halted with nothing to resume it.  It must resume from the DURABLE halted state instead.
    const healthy = await applyBrokerOrderPlacementPause({
      userId,
      connectedAccountId: accountId,
      accountScope: accountId,
      health: { isHealthy: true },
      policy: staleSnapshot
    });
    expect(healthy.action).toBe("resumed");
    expect(getPolicy(userId, accountId).systemState).toBe("active");
    expect(getBrokerPlacementPauseMarker(userId, accountId)).toBeUndefined();
    expect(listAudit(100, userId).map((a) => a.kind)).toContain("broker_placement_auto_resumed");
  });

  it("a still-failing probe is recorded on the auto-pause, so a stuck pause shows its last check", async () => {
    const { getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const { userId, accountId } = await seedAccount({ autoResumeOnBoot: true, systemState: "active" });
    await autoHaltOnProbeTimeouts(userId, accountId);

    const before = await haltCause(userId, accountId);
    expect(before).toMatchObject({ kind: "broker_auto_pause" });
    expect(before?.kind === "broker_auto_pause" ? before.lastProbeAt : "x").toBeUndefined();
    expect(before?.summary).toMatch(/No failed broker check recorded since the pause\./);

    const still = await probe(userId, accountId, { isHealthy: false, reason: "Broker connectivity failure: socket hang up", category: "connectivity" });
    expect(still).toMatchObject({ action: "still_paused", autoOwned: true });
    const marker = getBrokerPlacementPauseMarker(userId, accountId);
    expect(marker?.lastProbeReason).toBe("Broker connectivity failure: socket hang up");
    expect(Number.isFinite(Date.parse(marker?.lastProbeAt ?? ""))).toBe(true);
    // The original halt reason and time are kept.
    expect(marker?.reason).toMatch(/^Broker health check timed out/);

    const after = await haltCause(userId, accountId);
    expect(after).toMatchObject({ kind: "broker_auto_pause", lastProbeReason: "Broker connectivity failure: socket hang up", lastProbeAt: marker?.lastProbeAt });
    expect(after?.summary).toMatch(/Last broker check .+ CT still failed: Broker connectivity failure: socket hang up\./);

    // A manual halt (no marker) is never given a probe record, so it can never look auto-owned.
    const manual = await seedAccount({ autoResumeOnBoot: true, systemState: "halted" });
    await probe(manual.userId, manual.accountId, { isHealthy: false, reason: "down", category: "connectivity" });
    expect(getBrokerPlacementPauseMarker(manual.userId, manual.accountId)).toBeUndefined();
  });

  it("an auto-pause says a restart will end it when Auto-resume on boot is off, and not when it is on", async () => {
    const { listNotificationEvents } = await import("../src/lib/db");
    const off = await seedAccount({ autoResumeOnBoot: false, systemState: "active" });
    await autoHaltOnProbeTimeouts(off.userId, off.accountId);
    const offCause = await haltCause(off.userId, off.accountId);
    expect(offCause).toMatchObject({ kind: "broker_auto_pause", resumesOnItsOwn: true, autoResumeOnBootNow: false });
    expect(offCause?.summary).toMatch(/Auto-resume on boot is off, so a restart or deploy before the broker recovers ends this auto-pause and leaves the account stopped\./);
    const offHalt = listNotificationEvents(off.userId, 50).find((e) => e.type === "kill_switch");
    expect(JSON.stringify(offHalt?.payload)).toMatch(/restart or deploy before the broker recovers ends this auto-pause/);

    const on = await seedAccount({ autoResumeOnBoot: true, systemState: "active" });
    await autoHaltOnProbeTimeouts(on.userId, on.accountId);
    const onCause = await haltCause(on.userId, on.accountId);
    expect(onCause).toMatchObject({ kind: "broker_auto_pause", autoResumeOnBootNow: true });
    expect(onCause?.summary).not.toMatch(/restart or deploy/);
    const onHalt = listNotificationEvents(on.userId, 50).find((e) => e.type === "kill_switch");
    expect(JSON.stringify(onHalt?.payload)).toMatch(/Will auto-resume when the broker order path recovers/);
    expect(JSON.stringify(onHalt?.payload)).not.toMatch(/restart or deploy/);

    // The env override counts as on, exactly as the boot interlock reads it.
    process.env.AUTONOMY_RESUME_ON_BOOT = "1";
    expect(await haltCause(off.userId, off.accountId)).toMatchObject({ autoResumeOnBootNow: true });
  });

  it("a drawdown-breaker halt is named as the breaker, not a person, until the account is re-armed", async () => {
    const { audit, getPolicy, setPolicy } = await import("../src/lib/db");
    const { userId, accountId } = await seedAccount({ autoResumeOnBoot: true, systemState: "active" });
    // strategy.ts, riskRules.drawdownBreakerAction "halted": setPolicy(halted), then the audit row.
    setPolicy({ ...getPolicy(userId, accountId), systemState: "halted" }, userId, accountId);
    audit(
      "policy_violation_drawdown",
      { runId: "r-1", reason: "Trailing drawdown 72.10% breached the 15% limit.", from: "active", revertedTo: "halted", action: "halted" },
      userId,
      accountId
    );
    // An owner settings edit while halted does not change who holds the halt.
    setPolicy({ ...getPolicy(userId, accountId), runCadenceMinutes: 45 }, userId, accountId);
    const cause = await haltCause(userId, accountId);
    expect(cause).toMatchObject({ kind: "breaker", resumesOnItsOwn: false, reason: "Trailing drawdown 72.10% breached the 15% limit." });
    expect(cause?.summary).toMatch(/^The drawdown circuit breaker stopped this account at .+ CT: Trailing drawdown 72\.10% breached the 15% limit\.  It will not start by itself\./);
    expect(cause?.summary).not.toMatch(/person/);

    // Re-armed, then stopped again: the breaker is history; the app has no record of the new stop.
    setPolicy({ ...getPolicy(userId, accountId), systemState: "active" }, userId, accountId);
    setPolicy({ ...getPolicy(userId, accountId), systemState: "halted" }, userId, accountId);
    const later = await haltCause(userId, accountId);
    expect(later).toMatchObject({ kind: "stopped" });
    expect(later?.summary).toMatch(/did not record who or what stopped it/);
    expect(later?.summary).not.toMatch(/by a person/);

    // An ADVISORY breach (no state change) never names the breaker.
    const advisory = await seedAccount({ autoResumeOnBoot: true, systemState: "halted" });
    audit("policy_violation_drawdown", { runId: "r-2", reason: "advisory breach", from: "active", action: "advisory" }, advisory.userId, advisory.accountId);
    expect(await haltCause(advisory.userId, advisory.accountId)).toMatchObject({ kind: "stopped" });
  });

  it("an auto-pause whose resume marker vanished without a record is named, not blamed on a person", async () => {
    const { clearBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const { getPolicy } = await import("../src/lib/db");
    const { userId, accountId } = await seedAccount({ autoResumeOnBoot: true, systemState: "active" });
    await autoHaltOnProbeTimeouts(userId, accountId);
    // The 2026-09-25 shape: the marker is gone, nothing audited a resume, an owner takeover, or a boot.
    clearBrokerPlacementPauseMarker(userId, accountId);

    expect(getPolicy(userId, accountId).systemState).toBe("halted");
    const cause = await haltCause(userId, accountId);
    expect(cause).toMatchObject({ kind: "auto_pause_lost", resumesOnItsOwn: false });
    expect(cause?.kind === "auto_pause_lost" ? cause.reason : "").toMatch(/^Broker health check timed out/);
    expect(cause?.summary).toMatch(/the record that lets it start again by itself is gone\.  It will not start by itself\./);
    // It never resumes by itself: ownership cannot be inferred from the audit trail.
    expect((await probe(userId, accountId, { isHealthy: true })).action).toBe("none");
    expect(getPolicy(userId, accountId).systemState).toBe("halted");
  });
});

describe("console run-state display of the halt cause (lane h5)", () => {
  it("folds the cause into the chip without changing the shared run-state word", async () => {
    const { deriveStateInfo, withHaltCause } = await import("../app/console/lib/derive");
    const halted = deriveStateInfo({ systemState: "halted", strategyAuthority: "decide" });

    const auto = withHaltCause(halted, {
      kind: "broker_auto_pause",
      resumesOnItsOwn: true,
      since: "2026-09-25T18:20:24Z",
      reason: "x",
      autoResumeOnBootNow: true,
      summary: "Paused by the app."
    });
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

    expect(
      withHaltCause(halted, { kind: "breaker", resumesOnItsOwn: false, at: "2026-09-18T15:00:00Z", reason: "dd", summary: "The drawdown circuit breaker stopped this account." })
    ).toMatchObject({ word: "Stopped", label: "Stopped · breaker", tone: "neg" });
    expect(
      withHaltCause(halted, { kind: "auto_pause_lost", resumesOnItsOwn: false, at: "2026-09-25T18:20:24Z", reason: "t", summary: "The app paused this account." })
    ).toMatchObject({ word: "Stopped", label: "Stopped · by app", tone: "neg" });

    expect(withHaltCause(halted, null)).toEqual(halted);
    const running = deriveStateInfo({ systemState: "active", strategyAuthority: "decide" });
    expect(withHaltCause(running, { kind: "stopped", resumesOnItsOwn: false, summary: "stale" })).toEqual(running);
  });

  it("chip tooltips keep the two-space sentence gap visible in HTML", async () => {
    const { deriveStateInfo, stateChipTitle, withHaltCause } = await import("../app/console/lib/derive");
    const { SENTENCE_GAP } = await import("../app/console/lib/format");
    const info = withHaltCause(deriveStateInfo({ systemState: "halted", strategyAuthority: "decide" }), {
      kind: "stopped",
      resumesOnItsOwn: false,
      summary: "No automatic pause is holding this account.  It stays stopped."
    });
    const title = stateChipTitle(info);
    expect(title.startsWith(`No automatic pause is holding this account.${SENTENCE_GAP}It stays stopped.${SENTENCE_GAP}`)).toBe(true);
    expect(title).not.toMatch(/ {2}/);
  });
});
