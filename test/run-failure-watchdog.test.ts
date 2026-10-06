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

async function addFailedRuns(n: number, summary?: string) {
  const d = await db();
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    d.insertStrategyRun(id, USER, ACCT, "WD1");
    d.finishStrategyRun(id, "failed", summary ?? `failure ${i}`, USER);
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

describe("strategyRunCountsTowardAutoHalt", () => {
  it("exempts stall and restart markers and keeps broker and LLM failures", async () => {
    const { strategyRunCountsTowardAutoHalt } = await import("../src/lib/trading-liveness");
    const { staleRunningRunSweepSummary, staleSweepFailureExemptsAutoHalt } = await import("../src/lib/db-execution");
    const counts = (summary: string) => strategyRunCountsTowardAutoHalt({ summary });

    expect(counts(staleRunningRunSweepSummary("2026-10-01T14:00:00.000Z", Date.parse("2026-10-01T15:00:00.000Z")))).toBe(false);
    expect(counts(staleRunningRunSweepSummary("2026-10-01T14:00:00.000Z", Date.parse("2026-10-01T13:00:00.000Z")))).toBe(false);
    expect(staleSweepFailureExemptsAutoHalt("process_restarted_mid_run")).toBe(true);
    expect(staleSweepFailureExemptsAutoHalt("stalled_no_progress")).toBe(true);
    expect(strategyRunCountsTowardAutoHalt({ crashReason: "process_restarted_mid_run", summary: "failure" })).toBe(false);
    expect(strategyRunCountsTowardAutoHalt({ crashReason: "stalled_no_progress", summary: "failure" })).toBe(false);
    expect(strategyRunCountsTowardAutoHalt({ haltExempt: true, summary: "Alpaca API HTTP 500" })).toBe(false);

    expect(counts("App process was stalled (event loop blocked 27s of 30s); broker not at fault")).toBe(false);
    expect(
      counts(
        "runSyntheticStopMonitor timeout — event-loop stall 12000ms of 15000ms (80%) dominated the window; the process could not run callbacks for most of it"
      )
    ).toBe(false);
    expect(counts("stale-limit-scan broker timeout (elapsed=15000ms, event-loop stall=120ms, 1%)")).toBe(true);
    expect(counts("Alpaca API HTTP 500: internal server error")).toBe(true);
    expect(counts("fetch failed")).toBe(true);
    expect(counts("Empty response returned from LLM API.")).toBe(true);
    expect(counts("OpenRouter 429 rate limit")).toBe(true);
  });
});

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

  it("ends the run-failure liveness episode when the streak recovers", async () => {
    await addFailedRuns(3);
    const w = await watchdog();
    const d = await db();
    await w.runFailureWatchdogTick();
    expect(d.getInternalSetting<string>("livenessDegradedSince:run_failure_streak")).toBeDefined();
    await addCompletedRun();
    await w.runFailureWatchdogTick();
    // The next episode must start its escalation clock fresh.
    expect(d.getInternalSetting<string>("livenessDegradedSince:run_failure_streak")).toBeUndefined();
  });

  it("ends the halted liveness episode when the owner re-arms the account", async () => {
    await addFailedRuns(5);
    const w = await watchdog();
    const d = await db();
    await w.runFailureWatchdogTick();
    expect(d.getInternalSetting<string>("livenessDegradedSince:run_failure_streak_halted")).toBeDefined();
    d.setPolicy({ ...d.getPolicy(USER, ACCT), systemState: "active" }, USER, ACCT);
    await w.runFailureWatchdogTick();
    expect(d.getInternalSetting<string>("livenessDegradedSince:run_failure_streak_halted")).toBeUndefined();
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

  it("does not halt when a run in flight at re-arm later fails", async () => {
    await addFailedRuns(5);
    const w = await watchdog();
    const d = await db();
    await w.runFailureWatchdogTick();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("halted");

    const inflightId = randomUUID();
    d.getDb()
      .prepare(
        `INSERT INTO strategy_runs (id, user_id, connected_account_id, account_number, started_at, status, summary)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`
      )
      .run(inflightId, USER, ACCT, "WD1", new Date(Date.now() - 120_000).toISOString(), "still running");

    d.setPolicy({ ...d.getPolicy(USER, ACCT), systemState: "active" }, USER, ACCT);
    notifyMock.sendNotification.mockClear();
    await w.runFailureWatchdogTick();
    const rearmAudit = d
      .getDb()
      .prepare(
        `SELECT created_at FROM audit_events
         WHERE user_id = ? AND connected_account_id = ? AND kind = 'policy_change'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(USER, ACCT) as { created_at: string };
    const saved = d.getInternalSetting<{ rearmedAt?: string }>(`runFailureWatch:${USER}:${ACCT}`);
    expect(saved?.rearmedAt).toBe(rearmAudit.created_at);
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("active");
    expect(w.getRunFailureHaltMarker(USER, ACCT)).toBeNull();
    expect(w.isRunBackedOff(USER, ACCT)).toBe(false);
    expect(notifyMock.sendNotification).not.toHaveBeenCalled();

    d.finishStrategyRun(inflightId, "failed", "in flight at re-arm", USER);
    await w.runFailureWatchdogTick();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("active");
    expect(w.getRunFailureHaltMarker(USER, ACCT)).toBeNull();

    const liveness = await import("../src/lib/trading-liveness");
    const summary = liveness.getTradingLivenessSummary();
    const row = summary?.accounts.find((a) => a.connectedAccountId === ACCT);
    expect(row?.consecutiveFailedRuns).toBe(0);
    expect(liveness.toPublicTradingLiveness(summary).maxConsecutiveFailedRuns).toBe(0);
  });

  it("does not halt on re-arm when an in-flight run already failed and raised the raw streak", async () => {
    await addFailedRuns(5);
    const w = await watchdog();
    const d = await db();
    await w.runFailureWatchdogTick();
    const inflightId = randomUUID();
    d.getDb()
      .prepare(
        `INSERT INTO strategy_runs (id, user_id, connected_account_id, account_number, started_at, status, summary)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`
      )
      .run(inflightId, USER, ACCT, "WD1", new Date(Date.now() - 120_000).toISOString(), "started before halt");
    d.finishStrategyRun(inflightId, "failed", "failed before re-arm", USER);
    d.setPolicy({ ...d.getPolicy(USER, ACCT), systemState: "active" }, USER, ACCT);
    await w.runFailureWatchdogTick();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("active");
    expect(w.getRunFailureHaltMarker(USER, ACCT)).toBeNull();
    const liveness = await import("../src/lib/trading-liveness");
    const row = liveness.getTradingLivenessSummary()?.accounts.find((a) => a.connectedAccountId === ACCT);
    expect(row?.consecutiveFailedRuns).toBe(0);
  });

  it("halts after N new failures that started after re-arm", async () => {
    await addFailedRuns(5);
    const w = await watchdog();
    const d = await db();
    await w.runFailureWatchdogTick();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("halted");
    d.setPolicy({ ...d.getPolicy(USER, ACCT), systemState: "active" }, USER, ACCT);
    await w.runFailureWatchdogTick();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("active");

    // Halt threshold in this file is 5.  Four post-re-arm failures stay armed.
    await addFailedRuns(4);
    await w.runFailureWatchdogTick();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("active");
    const liveness = await import("../src/lib/trading-liveness");
    const mid = liveness.getTradingLivenessSummary()?.accounts.find((a) => a.connectedAccountId === ACCT);
    expect(mid?.consecutiveFailedRuns).toBe(4);

    await addFailedRuns(1);
    await w.runFailureWatchdogTick();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("halted");
    expect(w.getRunFailureHaltMarker(USER, ACCT)?.consecutiveFailures).toBe(5);
  });

  it("resets the streak when a run that started after re-arm succeeds", async () => {
    await addFailedRuns(5);
    const w = await watchdog();
    const d = await db();
    await w.runFailureWatchdogTick();
    d.setPolicy({ ...d.getPolicy(USER, ACCT), systemState: "active" }, USER, ACCT);
    await w.runFailureWatchdogTick();
    await addCompletedRun();
    await w.runFailureWatchdogTick();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("active");
    expect(w.isRunBackedOff(USER, ACCT)).toBe(false);

    await addFailedRuns(1);
    await w.runFailureWatchdogTick();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("active");
    const liveness = await import("../src/lib/trading-liveness");
    const row = liveness.getTradingLivenessSummary()?.accounts.find((a) => a.connectedAccountId === ACCT);
    expect(row?.consecutiveFailedRuns).toBe(1);
  });

  it("alerts and backs off on an app-stall streak but does not auto-halt", async () => {
    const stall =
      "runSyntheticStopMonitor timeout — event-loop stall 12000ms of 15000ms (80%) dominated the window; the process could not run callbacks for most of it";
    await addFailedRuns(5, stall);
    const w = await watchdog();
    await w.runFailureWatchdogTick();
    expect(notifyMock.sendNotification).toHaveBeenCalled();
    expect(w.isRunBackedOff(USER, ACCT)).toBe(true);
    const d = await db();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("active");
    expect(w.getRunFailureHaltMarker(USER, ACCT)).toBeNull();
  });

  it("does not auto-halt a process-restart streak", async () => {
    await addFailedRuns(
      5,
      "Process restarted mid-run — marked failed by stale-run sweep (started at 2026-10-01T14:00:00.000Z)"
    );
    const w = await watchdog();
    await w.runFailureWatchdogTick();
    expect(w.isRunBackedOff(USER, ACCT)).toBe(true);
    const d = await db();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("active");
    expect(w.getRunFailureHaltMarker(USER, ACCT)).toBeNull();
  });

  it("still auto-halts a broker HTTP failure streak", async () => {
    await addFailedRuns(5, "Alpaca API HTTP 500: internal server error");
    const w = await watchdog();
    await w.runFailureWatchdogTick();
    const d = await db();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("halted");
    expect(w.getRunFailureHaltMarker(USER, ACCT)?.consecutiveFailures).toBe(5);
  });

  it("still auto-halts an LLM failure streak", async () => {
    await addFailedRuns(5, "Empty response returned from LLM API.");
    const w = await watchdog();
    await w.runFailureWatchdogTick();
    const d = await db();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("halted");
  });

  it("still auto-halts a broker timeout that only measured a small event-loop stall", async () => {
    await addFailedRuns(
      5,
      "stale-limit-scan broker timeout (elapsed=15000ms, event-loop stall=120ms, 1%)"
    );
    const w = await watchdog();
    await w.runFailureWatchdogTick();
    const d = await db();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("halted");
  });

  it("counts broker failures toward auto-halt when app stalls sit in the same streak", async () => {
    // Older broker failures, then newer stalls.  Stalls must not erase the broker count
    // and must not themselves complete the halt threshold (halt is 5; 4 broker + 4 stalls).
    const d = await db();
    const base = Date.parse("2026-10-01T14:00:00.000Z");
    const insert = (summary: string, offsetSec: number) => {
      const id = randomUUID();
      const iso = new Date(base + offsetSec * 1000).toISOString();
      d.getDb()
        .prepare(
          `INSERT INTO strategy_runs (id, user_id, connected_account_id, started_at, finished_at, status, summary)
           VALUES (?, ?, ?, ?, ?, 'failed', ?)`
        )
        .run(id, USER, ACCT, iso, iso, summary);
    };
    for (let i = 0; i < 4; i++) insert("fetch failed", i);
    for (let i = 0; i < 4; i++) {
      insert("App process was stalled (event loop blocked 27s of 30s); broker not at fault", 10 + i);
    }
    const w = await watchdog();
    await w.runFailureWatchdogTick();
    expect(w.isRunBackedOff(USER, ACCT)).toBe(true);
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("active");
    insert("fetch failed", 20);
    await w.runFailureWatchdogTick();
    expect(d.peekPolicy(USER, ACCT).systemState).toBe("halted");
    expect(w.getRunFailureHaltMarker(USER, ACCT)?.consecutiveFailures).toBe(5);
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
