import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// tick() awaits full multi-minute LLM strategy runs, so a still-running tick must not let the
// next 60s setInterval callback (or the immediate `void tick()` at startScheduler boot) start an
// overlapping tick — re-running both sweep lanes (~30 journalLane calls, ~60 synchronous SQLite
// writes each pass) and a checkBrokerHealth network call per account on top of an already-running
// pass. This exercises the REAL scheduler.ts tick()/tickInner() split via the exported test-only
// `_runSchedulerTickForTest`, hanging on a single early awaited lane (`drainMaterialEventQueue`)
// so the first tick is still in flight when a second is attempted.
const triggerMocks = vi.hoisted(() => ({
  drainMaterialEventQueue: vi.fn()
}));

vi.mock("../src/lib/triggers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/triggers")>();
  return { ...actual, drainMaterialEventQueue: triggerMocks.drainMaterialEventQueue };
});

// pruneTaskJournal() (called directly, uncaught, near the top of tickInner) is the one call in the
// tick body genuinely NOT wrapped in its own local try/catch -- everything else in tickInner
// swallows its own lane errors. It is the cleanest way to force a real throw out of tickInner and
// prove the guard clears in `finally` regardless.
const journalMocks = vi.hoisted(() => ({
  pruneTaskJournal: vi.fn()
}));

vi.mock("../src/lib/db-task-journal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db-task-journal")>();
  return { ...actual, pruneTaskJournal: journalMocks.pruneTaskJournal };
});

const metricsMocks = vi.hoisted(() => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  recordSchedulerTick: vi.fn()
}));

vi.mock("../src/lib/sentry-metrics", () => metricsMocks);

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  // Single-leader gate off: this test only cares about the tick-level re-entrancy guard, not the
  // separate multi-process leader election (already covered by scheduler-leader-heartbeat.test.ts).
  vi.stubEnv("SCHEDULER_SINGLE_LEADER", "0");
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tick-reentry-${randomUUID()}.db`)}`;
  triggerMocks.drainMaterialEventQueue.mockReset();
  journalMocks.pruneTaskJournal.mockReset();
  metricsMocks.logWarn.mockReset();
  metricsMocks.logError.mockReset();
  metricsMocks.recordSchedulerTick.mockReset();
  // Defensive reset: the guard is globalThis-pinned (by design — see scheduler.ts's tickGuardHost
  // comment) so it survives module reset and could otherwise leak from another test file sharing
  // this worker process.
  const host = globalThis as {
    __tickInFlight?: boolean;
    __tickStartedAtMs?: number;
    __tickGeneration?: number;
    __tickSentryCheckInId?: string;
  };
  host.__tickInFlight = false;
  host.__tickStartedAtMs = undefined;
  host.__tickGeneration = 0;
  host.__tickSentryCheckInId = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("scheduler tick() re-entrancy guard", () => {
  it("skips an overlapping tick while the previous one is still in flight, then runs normally once it clears", async () => {
    const { _runSchedulerTickForTest } = await import("../src/lib/scheduler");

    let releaseDrain: (() => void) | undefined;
    triggerMocks.drainMaterialEventQueue.mockImplementation(
      () => new Promise<void>((resolve) => { releaseDrain = resolve; })
    );

    const first = _runSchedulerTickForTest();
    // Let the first tick actually reach and hang on the mocked lane before firing the second.
    await vi.waitFor(() => expect(triggerMocks.drainMaterialEventQueue).toHaveBeenCalledTimes(1));

    // A second tick fired while the first is still in flight (the exact "next 60s interval while
    // a multi-minute LLM run is still going" scenario) must return immediately without re-entering
    // the sweep/per-account body -- drainMaterialEventQueue must NOT be called a second time.
    await _runSchedulerTickForTest();
    expect(triggerMocks.drainMaterialEventQueue).toHaveBeenCalledTimes(1);
    expect(metricsMocks.logWarn).toHaveBeenCalledWith("scheduler.overrun", { reason: "in_flight" });
    expect(metricsMocks.recordSchedulerTick).toHaveBeenCalledWith("overrun");

    // Let the first tick's hung lane resolve and the tick finish. Reconfigure the mock to resolve
    // immediately from here on -- the earlier hanging implementation would otherwise also hang the
    // THIRD tick below (a new never-resolving promise every call), which is a test-harness footgun
    // rather than anything scheduler.ts does.
    releaseDrain!();
    triggerMocks.drainMaterialEventQueue.mockImplementation(() => Promise.resolve());
    await first;

    // Guard released in `finally` once the first tick genuinely completes -- a later tick must run
    // normally again (not be permanently wedged by the earlier overlap).
    await _runSchedulerTickForTest();
    expect(triggerMocks.drainMaterialEventQueue).toHaveBeenCalledTimes(2);
  });

  it("clears the guard via finally even when tickInner throws past its own error handling", async () => {
    const { _runSchedulerTickForTest } = await import("../src/lib/scheduler");

    journalMocks.pruneTaskJournal.mockImplementation(() => {
      throw new Error("boom");
    });

    // Nothing local catches this one -- it must propagate out of tickInner and reject the tick()
    // wrapper's own promise. The guard release must still happen via `finally`, not a `catch`.
    await expect(_runSchedulerTickForTest()).rejects.toThrow("boom");
    expect((globalThis as { __tickInFlight?: boolean }).__tickInFlight).toBe(false);

    // A tick after the throw must not be permanently wedged behind a guard that never cleared.
    journalMocks.pruneTaskJournal.mockReset();
    await _runSchedulerTickForTest();
    expect(journalMocks.pruneTaskJournal).toHaveBeenCalledTimes(1);
  });
});
