// Regression coverage for the scheduler's error-classification / log-dedup observability added
// alongside the Tradier order-capability probe fix. Production evidence (litestream-runtime.log,
// 2026-08-29..2026-09-07): a single restricted/misbehaving Tradier account generated 1,364
// identical "[scheduler] Tradier order capability probe failed" lines because the health-gate
// skip warn re-logged the SAME cause on every 60s tick. These tests exercise the pure
// log-dedup / lane-failure-classification helpers directly (no DB, no broker) rather than
// driving a full tick — the helpers have no side effects beyond console/Sentry logging.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentryMetricsMock = vi.hoisted(() => ({
  logWarn: vi.fn(),
  logError: vi.fn()
}));

vi.mock("../src/lib/sentry-metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/sentry-metrics")>();
  return { ...actual, logWarn: sentryMetricsMock.logWarn, logError: sentryMetricsMock.logError };
});

beforeEach(() => {
  sentryMetricsMock.logWarn.mockReset();
  sentryMetricsMock.logError.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logHealthGateSkip / clearHealthGateSkip", () => {
  it("logs once on the first occurrence of a cause and emits an account_skip_started structured event", async () => {
    const { logHealthGateSkip, _resetSchedulerObservabilityStateForTest } = await import("../src/lib/scheduler");
    _resetSchedulerObservabilityStateForTest();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logHealthGateSkip("local:acct-1", "Tradier order capability probe failed: boom", false);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("Tradier order capability probe failed: boom");
    expect(sentryMetricsMock.logWarn).toHaveBeenCalledWith(
      "scheduler.health_gate",
      expect.objectContaining({ event: "account_skip_started", key: "local:acct-1" })
    );
  });

  it("does NOT re-log an unchanged cause on subsequent ticks (the 1,364-line production bug)", async () => {
    const { logHealthGateSkip, _resetSchedulerObservabilityStateForTest } = await import("../src/lib/scheduler");
    _resetSchedulerObservabilityStateForTest();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const reason = "Tradier order capability probe failed: boom";
    for (let i = 0; i < 10; i++) {
      logHealthGateSkip("local:acct-1", reason, false);
    }

    // Only the first occurrence logs — the other 9 identical-cause ticks stay silent (well under
    // the 30-tick heartbeat threshold), directly addressing the 1,364-line production volume.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(sentryMetricsMock.logWarn).toHaveBeenCalledTimes(1);
  });

  it("re-logs immediately when the cause (reason or halt state) changes", async () => {
    const { logHealthGateSkip, _resetSchedulerObservabilityStateForTest } = await import("../src/lib/scheduler");
    _resetSchedulerObservabilityStateForTest();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logHealthGateSkip("local:acct-1", "Tradier order capability probe failed: boom", false);
    logHealthGateSkip("local:acct-1", "Tradier order capability probe failed: boom", false);
    logHealthGateSkip("local:acct-1", "Account equity too low", false); // new cause
    logHealthGateSkip("local:acct-1", "Account equity too low", true); // same reason, now auto-halted

    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy.mock.calls[2]?.[0]).toContain("(auto-halted)");
    expect(sentryMetricsMock.logWarn).toHaveBeenLastCalledWith(
      "scheduler.health_gate",
      expect.objectContaining({ event: "account_skip_started", halted: true })
    );
  });

  it("does not emit (auto-halted) or halted:true for a manual owner pause", async () => {
    const { logHealthGateSkip, _resetSchedulerObservabilityStateForTest } = await import("../src/lib/scheduler");
    _resetSchedulerObservabilityStateForTest();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logHealthGateSkip("local:acct-1", "OMS down", false);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).not.toContain("auto-halted");
    expect(sentryMetricsMock.logWarn).toHaveBeenCalledWith(
      "scheduler.health_gate",
      expect.objectContaining({ event: "account_skip_started", key: "local:acct-1", halted: false })
    );
  });

  it("emits a low-rate heartbeat instead of staying silent forever on a sustained cause", async () => {
    const { logHealthGateSkip, HEALTH_SKIP_HEARTBEAT_EVERY, _resetSchedulerObservabilityStateForTest } = await import(
      "../src/lib/scheduler"
    );
    _resetSchedulerObservabilityStateForTest();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const reason = "Tradier order capability probe failed: boom";
    for (let i = 0; i < HEALTH_SKIP_HEARTBEAT_EVERY; i++) {
      logHealthGateSkip("local:acct-1", reason, false);
    }

    // First occurrence + one heartbeat at the threshold.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[1]?.[0]).toContain("still unhealthy");
  });

  it("clearHealthGateSkip announces recovery only when the account was previously unhealthy", async () => {
    const { logHealthGateSkip, clearHealthGateSkip, _resetSchedulerObservabilityStateForTest } = await import(
      "../src/lib/scheduler"
    );
    _resetSchedulerObservabilityStateForTest();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    clearHealthGateSkip("local:never-unhealthy"); // no-op, was never logged
    expect(sentryMetricsMock.logWarn).not.toHaveBeenCalled();

    logHealthGateSkip("local:acct-1", "boom", false);
    clearHealthGateSkip("local:acct-1");
    expect(sentryMetricsMock.logWarn).toHaveBeenLastCalledWith(
      "scheduler.health_gate",
      expect.objectContaining({ event: "account_skip_recovered", key: "local:acct-1" })
    );

    // A second clear on the same (already-cleared) key must not double-announce.
    sentryMetricsMock.logWarn.mockClear();
    clearHealthGateSkip("local:acct-1");
    expect(sentryMetricsMock.logWarn).not.toHaveBeenCalled();
  });
});

describe("classifyLaneFailure", () => {
  it("classifies an AbortError / timeout distinctly from a dead-socket transient network error", async () => {
    const { classifyLaneFailure } = await import("../src/lib/scheduler");
    expect(classifyLaneFailure(new Error("runSyntheticStopMonitor timeout"))).toBe("timeout");
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    expect(classifyLaneFailure(abort)).toBe("timeout");
    expect(classifyLaneFailure(new TypeError("fetch failed"))).toBe("transient_network");
    const socketErr = new Error("other side closed");
    socketErr.name = "SocketError";
    expect(classifyLaneFailure(socketErr)).toBe("transient_network");
    expect(classifyLaneFailure(new Error("something unrelated exploded"))).toBe("other");
  });
});

describe("recordLaneFailure / recordLaneRecovery", () => {
  it("logs every occurrence but only escalates to lane_degraded once a streak crosses the threshold", async () => {
    const { recordLaneFailure, LANE_DEGRADED_STREAK_THRESHOLD, _resetSchedulerObservabilityStateForTest } =
      await import("../src/lib/scheduler");
    _resetSchedulerObservabilityStateForTest();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (let i = 0; i < LANE_DEGRADED_STREAK_THRESHOLD; i++) {
      recordLaneFailure("synthetic-stop monitor", "local:acct-1", new TypeError("fetch failed"));
    }

    expect(errorSpy).toHaveBeenCalledTimes(LANE_DEGRADED_STREAK_THRESHOLD);
    expect(sentryMetricsMock.logError).toHaveBeenCalledTimes(1);
    expect(sentryMetricsMock.logError).toHaveBeenCalledWith(
      "scheduler.lane",
      expect.objectContaining({
        event: "lane_degraded",
        lane: "synthetic-stop monitor",
        key: "local:acct-1",
        category: "transient_network",
        streak: LANE_DEGRADED_STREAK_THRESHOLD
      })
    );

    // A further failure of the SAME category must not re-announce an already-degraded lane.
    recordLaneFailure("synthetic-stop monitor", "local:acct-1", new TypeError("fetch failed"));
    expect(sentryMetricsMock.logError).toHaveBeenCalledTimes(1);
  });

  it("a different failure category resets the streak instead of accumulating across categories", async () => {
    const { recordLaneFailure, LANE_DEGRADED_STREAK_THRESHOLD, _resetSchedulerObservabilityStateForTest } =
      await import("../src/lib/scheduler");
    _resetSchedulerObservabilityStateForTest();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (let i = 0; i < LANE_DEGRADED_STREAK_THRESHOLD - 1; i++) {
      recordLaneFailure("stale-limit-order handling", "local:acct-2", new TypeError("fetch failed"));
    }
    // Category flips to "timeout" — streak restarts at 1, must not itself trip the threshold.
    recordLaneFailure("stale-limit-order handling", "local:acct-2", new Error("stale-limit-scan broker timeout"));

    expect(sentryMetricsMock.logError).not.toHaveBeenCalled();
  });

  it("recordLaneRecovery announces recovery only after a lane had gone degraded", async () => {
    const { recordLaneFailure, recordLaneRecovery, LANE_DEGRADED_STREAK_THRESHOLD, _resetSchedulerObservabilityStateForTest } =
      await import("../src/lib/scheduler");
    _resetSchedulerObservabilityStateForTest();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Never degraded — recovery is a silent no-op.
    recordLaneFailure("synthetic-stop monitor", "local:acct-3", new TypeError("fetch failed"));
    recordLaneRecovery("synthetic-stop monitor", "local:acct-3");
    expect(sentryMetricsMock.logWarn).not.toHaveBeenCalled();

    // Cross the threshold, then recover — this time recovery must announce.
    for (let i = 0; i < LANE_DEGRADED_STREAK_THRESHOLD; i++) {
      recordLaneFailure("synthetic-stop monitor", "local:acct-3", new TypeError("fetch failed"));
    }
    recordLaneRecovery("synthetic-stop monitor", "local:acct-3");
    expect(sentryMetricsMock.logWarn).toHaveBeenCalledWith(
      "scheduler.lane",
      expect.objectContaining({ event: "lane_recovered", lane: "synthetic-stop monitor", key: "local:acct-3" })
    );
  });

  // Codex round-1 review (2026-09-07): a failure-category change while already degraded used to
  // reset `degraded` to false even though nothing had actually recovered, which both suppressed
  // the eventual lane_recovered event and let the entry silently lose its degraded status.
  it("preserves degraded status across a failure-category change (does not require a fresh streak to re-degrade)", async () => {
    const { recordLaneFailure, recordLaneRecovery, LANE_DEGRADED_STREAK_THRESHOLD, _resetSchedulerObservabilityStateForTest } =
      await import("../src/lib/scheduler");
    _resetSchedulerObservabilityStateForTest();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Cross the threshold on "transient_network" — now degraded, one lane_degraded emitted.
    for (let i = 0; i < LANE_DEGRADED_STREAK_THRESHOLD; i++) {
      recordLaneFailure("stale-limit-order handling", "local:acct-4", new TypeError("fetch failed"));
    }
    expect(sentryMetricsMock.logError).toHaveBeenCalledTimes(1);

    // Category flips to "timeout" — streak restarts at 1 for the new category, but the lane
    // was already degraded and nothing has actually recovered, so it must STAY degraded: no
    // duplicate lane_degraded emission, and a subsequent recovery must still announce.
    recordLaneFailure("stale-limit-order handling", "local:acct-4", new Error("stale-limit-scan broker timeout"));
    expect(sentryMetricsMock.logError).toHaveBeenCalledTimes(1); // no re-emission

    recordLaneRecovery("stale-limit-order handling", "local:acct-4");
    expect(sentryMetricsMock.logWarn).toHaveBeenCalledWith(
      "scheduler.lane",
      expect.objectContaining({ event: "lane_recovered", lane: "stale-limit-order handling", key: "local:acct-4" })
    );
  });
});

// Codex round-1 review (2026-09-07, sentry + chatgpt-codex-connector, duplicate findings): a race
// condition let a timed-out lane that later succeeded in the background incorrectly clear its own
// just-recorded failure streak, because recordLaneRecovery was attached to the RAW work promise
// instead of the withDeadline-raced promise. This exercises the exact wiring pattern scheduler.ts
// now uses for both the stale-limit-order and synthetic-stop-monitor lanes: recovery/failure must
// both key off the SAME deadline-raced promise so a late background fulfillment cannot silently
// clear a failure the deadline already recorded.
describe("recordLaneRecovery / recordLaneFailure wiring against withDeadline (race-condition fix)", () => {
  it("a late background fulfillment after a timeout must NOT clear the failure streak", async () => {
    const { withDeadline } = await import("../src/lib/inflight-deadline");
    const {
      recordLaneFailure,
      recordLaneRecovery,
      LANE_DEGRADED_STREAK_THRESHOLD,
      _resetSchedulerObservabilityStateForTest
    } = await import("../src/lib/scheduler");
    _resetSchedulerObservabilityStateForTest();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const lane = "stale-limit-order handling";
    const key = "local:acct-race";

    for (let i = 0; i < LANE_DEGRADED_STREAK_THRESHOLD; i++) {
      // Slow work that resolves AFTER the deadline elapses — the exact race condition: a lane
      // that always times out but always eventually succeeds in the background.
      const slowWork = new Promise<void>((resolve) => setTimeout(resolve, 30));
      const raced = withDeadline(slowWork, 5, "test lane timeout");
      // The fixed wiring: recovery/failure both attach to `raced`, never to `slowWork` directly.
      const settled = raced
        .then(() => recordLaneRecovery(lane, key))
        .catch((err) => recordLaneFailure(lane, key, err));
      await settled; // the deadline (5ms) always loses to slowWork (30ms) here, so this rejects
      await slowWork; // let the background work ALSO finish, as it would in production
    }

    // Every iteration timed out, and the buggy wiring would have let each late fulfillment of
    // slowWork call recordLaneRecovery and wipe the streak — asserting escalation here proves it
    // did not.
    expect(sentryMetricsMock.logError).toHaveBeenCalledTimes(1);
    expect(sentryMetricsMock.logError).toHaveBeenCalledWith(
      "scheduler.lane",
      expect.objectContaining({ event: "lane_degraded", lane, key, category: "timeout" })
    );
    expect(sentryMetricsMock.logWarn).not.toHaveBeenCalled(); // no spurious lane_recovered
  });
});

describe("isHaltedPauseAction", () => {
  it("treats the auto-halt transition and later auto-owned still_paused ticks as halted", async () => {
    const { isHaltedPauseAction } = await import("../src/lib/scheduler");
    expect(isHaltedPauseAction({ action: "halted", reason: "oms down" })).toBe(true);
    expect(isHaltedPauseAction({ action: "still_paused", reason: "oms down", autoOwned: true })).toBe(true);
    expect(isHaltedPauseAction({ action: "resumed" })).toBe(false);
    expect(isHaltedPauseAction({ action: "none" })).toBe(false);
  });

  it("does not treat a manual owner still_paused as auto-halted", async () => {
    const { isHaltedPauseAction } = await import("../src/lib/scheduler");
    expect(isHaltedPauseAction({ action: "still_paused", reason: "oms down", autoOwned: false })).toBe(false);
  });
});
