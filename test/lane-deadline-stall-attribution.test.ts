// Attribution of a blown safety-lane deadline: broker latency vs a pinned event loop.
//
// Production evidence this encodes (2026-09-09, task_journal on container d83b1aykr03uwr32yhgzaiay):
//   stale-limit-scan @ 2026-09-08T19:51:57.566Z ran 185_633ms carrying the inner error
//   "Timed out waiting for alpaca.getOrders after 16000+8000ms." — the broker call gave up at
//   24s, so 161_633ms of that lane was NOT broker I/O.  synthetic-stop-monitor @
//   2026-09-09T13:45:41.103Z ran 196_840ms and finished `ok evaluated=6`.  The lane succeeded;
//   the deadline had already blamed the broker.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  withLaneDeadline,
  isLaneDeadlineExpiry,
  LANE_STALL_ATTRIBUTION_RATIO,
  type LaneDeadlineExpiry
} from "../src/lib/safety-maintenance";
import {
  stalledMsSince,
  startEventLoopLagSampler,
  _resetEventLoopLagForTest,
  _recordEventLoopLagForTest
} from "../src/lib/event-loop-lag";
import {
  classifyLaneFailure,
  recordLaneFailure,
  _resetSchedulerObservabilityStateForTest
} from "../src/lib/scheduler";

const never = () => new Promise<void>(() => {});

describe("event-loop lag accounting", () => {
  beforeEach(() => _resetEventLoopLagForTest());
  afterEach(() => _resetEventLoopLagForTest());

  it("sums only stalls inside the queried window", () => {
    const now = Date.now();
    _recordEventLoopLagForTest(now - 30_000, 9_000); // before the window — ignored
    _recordEventLoopLagForTest(now - 5_000, 4_000); // inside
    expect(stalledMsSince(now - 10_000)).toBeGreaterThanOrEqual(4_000);
    expect(stalledMsSince(now - 10_000)).toBeLessThan(9_000);
  });

  it("reports no stall on a healthy loop", () => {
    startEventLoopLagSampler();
    expect(stalledMsSince(Date.now() - 1_000)).toBe(0);
  });

  it("clamps a sample that straddles the window start", () => {
    const now = Date.now();
    // A 10s stall observed 2s ago can only have contributed 2s to a window that began then.
    _recordEventLoopLagForTest(now - 2_000, 10_000);
    expect(stalledMsSince(now - 2_500)).toBeLessThanOrEqual(2_500);
  });
});

describe("withLaneDeadline", () => {
  beforeEach(() => _resetEventLoopLagForTest());
  afterEach(() => {
    _resetEventLoopLagForTest();
    vi.restoreAllMocks();
  });

  it("passes a value straight through when the work beats the deadline", async () => {
    await expect(withLaneDeadline(Promise.resolve("ok"), 1_000, "m", "lane")).resolves.toBe("ok");
  });

  it("passes a REAL lane error through untouched — only the deadline's own expiry is re-attributed", async () => {
    const real = new Error("broker returned 500");
    await expect(withLaneDeadline(Promise.reject(real), 1_000, "m", "lane")).rejects.toBe(real);
  });

  it("attributes an expiry to the event loop when the loop was pinned for most of the window", async () => {
    let err: unknown;
    try {
      await withLaneDeadline(never(), 40, "runSyntheticStopMonitor timeout", "synthetic-stop-monitor");
    } catch (e) {
      err = e;
    }
    expect(isLaneDeadlineExpiry(err)).toBe(true);
    expect((err as LaneDeadlineExpiry).elapsedMs).toBeGreaterThan(0);
    expect((err as LaneDeadlineExpiry).stalledMs).toBeGreaterThanOrEqual(0);
  });

  it("classifies a stall-dominated expiry as event_loop_stall, NOT a broker timeout", () => {
    const stall = Object.assign(new Error("runSyntheticStopMonitor timeout — event-loop stall 12000ms of 15000ms (80%)"), {
      __laneDeadlineExpiry: true as const,
      elapsedMs: 15_000,
      stalledMs: 12_000,
      stallRatio: 0.8
    });
    expect(classifyLaneFailure(stall)).toBe("event_loop_stall");
  });

  it("still classifies a genuinely broker-bound expiry as timeout", () => {
    const brokerBound = Object.assign(new Error("stale-limit-scan broker timeout (elapsed=15000ms, event-loop stall=120ms)"), {
      __laneDeadlineExpiry: true as const,
      elapsedMs: 15_000,
      stalledMs: 120,
      stallRatio: 0.008
    });
    expect(classifyLaneFailure(brokerBound)).toBe("timeout");
  });

  it("holds the attribution threshold high enough that the broker cannot be the explanation", () => {
    expect(LANE_STALL_ATTRIBUTION_RATIO).toBe(0.75);
  });

  // Codex P2: a stall ratio does not prove the broker was healthy.  A request pending for the
  // WHOLE 15s window alongside an unrelated 4s stall clears a 25% bar; it must not be labelled a
  // stall exclusively, or a real broker outage disappears.
  it("does NOT re-attribute when a broker request could still explain the window", () => {
    const brokerPendingWholeWindowPlusSmallStall = Object.assign(new Error("stale-limit-scan broker timeout"), {
      __laneDeadlineExpiry: true as const,
      elapsedMs: 15_000,
      stalledMs: 4_000,
      stallRatio: 4_000 / 15_000 // 26.7% — over the old 0.25 bar, under the new one
    });
    expect(classifyLaneFailure(brokerPendingWholeWindowPlusSmallStall)).toBe("timeout");
  });

  it("SAFETY: the deadline never cancels the protective pass — late work still completes", async () => {
    let completed = false;
    const work = new Promise<string>((resolve) =>
      setTimeout(() => {
        completed = true;
        resolve("evaluated=6");
      }, 60)
    );
    await expect(withLaneDeadline(work, 20, "runSyntheticStopMonitor timeout", "synthetic-stop-monitor")).rejects.toThrow();
    await work;
    expect(completed).toBe(true);
  });

  it("SAFETY: a late completion is announced so an operator can tell the pass actually ran", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const work = new Promise<string>((resolve) => setTimeout(() => resolve("evaluated=6"), 60));
    await withLaneDeadline(work, 20, "runSyntheticStopMonitor timeout", "synthetic-stop-monitor").catch(() => undefined);
    await work;
    await new Promise((r) => setTimeout(r, 10));
    expect(warn.mock.calls.some((c) => String(c[0]).includes("COMPLETED LATE"))).toBe(true);
  });
});

describe("streak continuity across deadline categories (Codex P1)", () => {
  beforeEach(() => _resetSchedulerObservabilityStateForTest());
  afterEach(() => {
    _resetSchedulerObservabilityStateForTest();
    vi.restoreAllMocks();
  });

  const expiry = (stallRatio: number) =>
    Object.assign(new Error("runSyntheticStopMonitor timeout"), {
      __laneDeadlineExpiry: true as const,
      elapsedMs: 15_000,
      stalledMs: Math.round(15_000 * stallRatio),
      stallRatio
    });

  it("still escalates lane_degraded when the stall ratio oscillates across the threshold", () => {
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    // Alternating categories: stall, timeout, stall.  Before the family fix each flip reset the
    // streak to 1, so an indefinitely failing safety lane never reached the threshold of 3.
    recordLaneFailure("synthetic-stop monitor", "acct", expiry(0.9));
    recordLaneFailure("synthetic-stop monitor", "acct", expiry(0.1));
    recordLaneFailure("synthetic-stop monitor", "acct", expiry(0.9));
    const streaks = errs.mock.calls.map((c) => String(c[0]));
    expect(streaks.some((l) => l.includes("streak=3"))).toBe(true);
  });

  it("does NOT merge a deadline expiry with an unrelated failure category", () => {
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    recordLaneFailure("synthetic-stop monitor", "acct2", expiry(0.9));
    recordLaneFailure("synthetic-stop monitor", "acct2", new Error("something else entirely"));
    const last = String(errs.mock.calls[errs.mock.calls.length - 1][0]);
    expect(last).toContain("streak=1");
  });
});

describe("late-completion wording matches what was wrapped (Codex P2)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a wrapped CALL must not claim the protective pass completed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const read = new Promise<string>((resolve) => setTimeout(() => resolve("orders"), 60));
    await withLaneDeadline(read, 20, "getEquityOrders timeout for stale-exit handling", "stale-limit-order handling", {
      wraps: "call"
    }).catch(() => undefined);
    await read;
    await new Promise((r) => setTimeout(r, 10));
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("ALREADY SKIPPED"))).toBe(true);
    expect(lines.some((l) => l.includes("COMPLETED LATE"))).toBe(false);
  });

  it("a skipped lane outcome must not be announced as a completed pass", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const skipped = new Promise<{ status: "skipped"; summary: string }>((resolve) =>
      setTimeout(() => resolve({ status: "skipped", summary: "account mutation lease busy" }), 60)
    );
    await withLaneDeadline(skipped, 20, "stale-limit-scan broker timeout", "stale-limit-scan").catch(() => undefined);
    await skipped;
    await new Promise((r) => setTimeout(r, 10));
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("SKIPPED LATE"))).toBe(true);
    expect(lines.some((l) => l.includes("COMPLETED LATE"))).toBe(false);
    expect(lines.some((l) => l.includes("FAILED LATE"))).toBe(false);
  });
});
