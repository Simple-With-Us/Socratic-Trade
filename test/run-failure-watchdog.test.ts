// Run-failure watchdog tests (2026-09-30 self-healing).
// Covers the pure backoff math, the durable backoff gate, and the full tick:
// alert on streak, exponential backoff engagement, auto-halt with marker, and
// recovery clearing the state.
//
// Isolated temp DB per the repo convention (DATABASE_URL=<redacted>
// sendNotification is mocked so no test pings a real channel; Sentry capture
// no-ops without SENTRY_DSN.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const notifyMock = vi.hoisted(() => ({ sendNotification: vi.fn(async () => {}) }));
vi.mock("../src/lib/notifications", () => ({ sendNotification: notifyMock.sendNotification }));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), "runfail-test-")), "test.db")}`;
});

const USER = "watchdog-test-user";
const ACCT = "watchdog-test-acct";

async function db() {
  return await import("../src/lib/db");
}
async function watchdog() {
  return await import("../src/lib/run-failure-watchdog");
}

async function setupActiveAccount() {
  const d = await db();
  d.upsertConnectedAccount({
    id: ACCT,
    userId: USER,
    broker: "alpaca",
    environment: "paper",
    accountNumber: "WD1",
    label: "Watchdog Test",
    isActive: true,
  });
  d.setPolicy({ ...d.getPolicy(USER, ACCT), systemState: "active" }, USER, ACCT);
}

async function addFailedRuns(n: number) {
  const d = await db();
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    d.insertStrategyRun(id, USER, ACCT, "WD1");
    d.finishStrategyRun(id, "failed", `failure ${i}`, USER);
  }
}

async function addCompletedRun() {
  const d = await db();
  const id = randomUUID();
  d.insertStrategyRun(id, USER, ACCT, "WD1");
  d.finishStrategyRun(id, "completed", "ok", USER);
}

async function clearAll() {
  const d = await db();
  const w = await watchdog();
  w.resetRunFailureWatchdogForTests();
  d.getDb().prepare("DELETE FROM strategy_runs WHERE user_id = ?").run(USER);
  d.getDb().prepare("DELETE FROM settings WHERE key LIKE 'liveness%'").run();
}

function setThresholds(alert: number, backoff: number, halt: number) {
  process.env.ST_RUN_FAILURE_ALERT_AFTER = String(alert);
  process.env.ST_RUN_FAILURE_BACKOFF_AFTER = String(backoff);
  process.env.ST_RUN_FAILURE_HALT_AFTER = String(halt);
}

describe("backoffMinutesForStreak", () => {
  it("is zero below the backoff threshold and base at it, doubling to the cap", async () => {
    setThresholds(2, 3, 10);
    process.env.ST_RUN_FAILURE_BACKOFF_BASE_MIN = "15";
    process.env.ST_RUN_FAILURE_BACKOFF_CAP_MIN = "60";
    const w = await watchdog();
    expect(w.backoffMinutesForStreak(2)).toBe(0);
    expect(w.backoffMinutesForStreak(3)).toBe(15);
    expect(w.backoffMinutesForStreak(4)).toBe(30);
    expect(w.backoffMinutesForStreak(5)).toBe(60);
    expect(w.backoffMinutesForStreak(9)).toBe(60); // capped
  });
});

describe("isRunBackedOff", () => {
  beforeEach(async () => {
    await clearAll();
    delete process.env.ST_RUN_FAILURE_ALERT_AFTER;
    delete process.env.ST_RUN_FAILURE_BACKOFF_AFTER;
    delete process.env.ST_RUN_FAILURE_HALT_AFTER;
  });

  it("is false with no watchdog state", async () => {
    const w = await watchdog();
    expect(w.isRunBackedOff(USER, ACCT)).toBe(false);
  });
});

describe("runFailureWatchdogTick", () => {
  beforeEach(async () => {
    notifyMock.sendNotification.mockClear();
    await clearAll();
    await setupActiveAccount();
    setThresholds(2, 3, 5);
    process.env.ST_RUN_FAILURE_BACKOFF_BASE_MIN = "15";
    process.env.ST_RUN_FAILURE_BACKOFF_CAP_MIN = "240";
  });

  it("alerts when the streak crosses the alert threshold", async () => {
    await addFailedRuns(2);
    const w = await watchdog();
    await w.runFailureWatchdogTick();
    // alertLivenessWarning fans out to admins via sendNotification
    expect(notifyMock.sendNotification).toHaveBeenCalled();
    const d = await db();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("active"); // alert only, no halt yet
  });

  it("engages backoff at the backoff threshold", async () => {
    await addFailedRuns(3);
    const w = await watchdog();
    await w.runFailureWatchdogTick();
    expect(w.isRunBackedOff(USER, ACCT)).toBe(true);
    const d = await db();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("active"); // backed off, not halted
  });

  it("auto-halts at the halt threshold with a durable marker", async () => {
    await addFailedRuns(5);
    const w = await watchdog();
    await w.runFailureWatchdogTick();
    const d = await db();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("halted");
    const marker = w.getRunFailureHaltMarker(USER, ACCT);
    expect(marker).not.toBeNull();
    expect(marker?.autoResume).toBe(false);
    expect(marker?.consecutiveFailures).toBeGreaterThanOrEqual(5);
  });

  it("does not re-halt or duplicate-halt on the next tick", async () => {
    await addFailedRuns(5);
    const w = await watchdog();
    await w.runFailureWatchdogTick();
    const d = await db();
    const auditBefore = d
      .getDb()
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'run_failure_auto_halted'")
      .get() as { n: number };
    await w.runFailureWatchdogTick();
    const auditAfter = d
      .getDb()
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'run_failure_auto_halted'")
      .get() as { n: number };
    expect(auditAfter.n).toBe(auditBefore.n);
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("halted");
  });

  it("clears the streak state when a run completes (recovery)", async () => {
    await addFailedRuns(3);
    const w = await watchdog();
    await w.runFailureWatchdogTick();
    expect(w.isRunBackedOff(USER, ACCT)).toBe(true);
    await addCompletedRun();
    await w.runFailureWatchdogTick();
    expect(w.isRunBackedOff(USER, ACCT)).toBe(false);
  });

  it("clears the halt marker when the owner re-arms the account", async () => {
    await addFailedRuns(5);
    const w = await watchdog();
    await w.runFailureWatchdogTick();
    const d = await db();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("halted");
    // Owner re-arms from the console.
    d.setPolicy({ ...d.getPolicy(USER, ACCT), systemState: "active" }, USER, ACCT);
    await w.runFailureWatchdogTick();
    expect(w.getRunFailureHaltMarker(USER, ACCT)).toBeNull();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("active");
  });

  it("re-halts after re-arm only when NEW failures grow the streak", async () => {
    await addFailedRuns(5);
    const w = await watchdog();
    await w.runFailureWatchdogTick();
    const d = await db();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("halted");
    // Owner re-arms; the old 5-failure streak is still in the DB.
    d.setPolicy({ ...d.getPolicy(USER, ACCT), systemState: "active" }, USER, ACCT);
    await w.runFailureWatchdogTick();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("active"); // not instantly undone
    expect(w.getRunFailureHaltMarker(USER, ACCT)).toBeNull();
    // One more failure grows the streak to 6 > halt-time floor 5 -> re-halt.
    await addFailedRuns(1);
    await w.runFailureWatchdogTick();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("halted");
    expect(w.getRunFailureHaltMarker(USER, ACCT)).not.toBeNull();
  });

  it("never touches an account that is not active", async () => {
    const d = await db();
    d.setPolicy({ ...d.getPolicy(USER, ACCT), systemState: "halted" }, USER, ACCT);
    await addFailedRuns(5);
    const w = await watchdog();
    await w.runFailureWatchdogTick();
    // No marker: the watchdog only halts accounts it saw active.
    expect(w.getRunFailureHaltMarker(USER, ACCT)).toBeNull();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("halted");
  });
});
