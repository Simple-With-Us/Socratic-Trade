import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Live 2026-08-31: scheduler-tick missed check-in while the Node process stayed up.
// tick() skipped every later 60s interval while tickInner awaited a hung lane, so the
// 90s lease expired, lastTick froze, and Sentry had already been told "ok" at start.
const triggerMocks = vi.hoisted(() => ({
  drainMaterialEventQueue: vi.fn()
}));

const sentryMock = vi.hoisted(() => ({
  // Typed with real (if unused) params so `.mock.calls[i][0]` infers as `unknown` rather than
  // a zero-length tuple — a bare `() => "check-in-id"` makes tsc reject every `call[0] as {...}`
  // cast below with "neither type sufficiently overlaps".
  captureCheckIn: vi.fn((_checkIn: unknown, _monitorConfig?: unknown) => "check-in-id")
}));

vi.mock("../src/lib/triggers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/triggers")>();
  return { ...actual, drainMaterialEventQueue: triggerMocks.drainMaterialEventQueue };
});

vi.mock("@sentry/nextjs", () => ({
  captureCheckIn: sentryMock.captureCheckIn
}));

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("SCHEDULER_SINGLE_LEADER", "0");
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tick-watchdog-${randomUUID()}.db`)}`;
  triggerMocks.drainMaterialEventQueue.mockReset();
  sentryMock.captureCheckIn.mockReset();
  sentryMock.captureCheckIn.mockImplementation(() => "check-in-id");
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
});

function inFlight(): boolean {
  return (globalThis as { __tickInFlight?: boolean }).__tickInFlight === true;
}

describe("scheduler tick watchdog", () => {
  it("leaves the in-flight guard in place before the watchdog budget", async () => {
    const { _runSchedulerTickForTest, runSchedulerTickWatchdog } = await import("../src/lib/scheduler");
    let releaseDrain: (() => void) | undefined;
    triggerMocks.drainMaterialEventQueue.mockImplementation(
      () => new Promise<void>((resolve) => { releaseDrain = resolve; })
    );

    const first = _runSchedulerTickForTest();
    await vi.waitFor(() => expect(triggerMocks.drainMaterialEventQueue).toHaveBeenCalledTimes(1));
    expect(inFlight()).toBe(true);
    expect(runSchedulerTickWatchdog(Date.now())).toBe("waiting");
    expect(inFlight()).toBe(true);

    triggerMocks.drainMaterialEventQueue.mockImplementation(() => Promise.resolve());
    releaseDrain!();
    await first;
  });

  it("unwedges a hung tick so a later interval can run, and does not stamp lastTick while hung", async () => {
    const { _runSchedulerTickForTest, runSchedulerTickWatchdog, DEFAULT_TICK_WATCHDOG_MS } =
      await import("../src/lib/scheduler");
    const db = await import("../src/lib/db");
    let releaseDrain: (() => void) | undefined;
    triggerMocks.drainMaterialEventQueue.mockImplementation(
      () => new Promise<void>((resolve) => { releaseDrain = resolve; })
    );

    const first = _runSchedulerTickForTest();
    await vi.waitFor(() => expect(triggerMocks.drainMaterialEventQueue).toHaveBeenCalledTimes(1));
    expect(db.getInternalSetting("scheduler:lastTick")).toBeUndefined();

    triggerMocks.drainMaterialEventQueue.mockImplementation(() => Promise.resolve());
    const result = runSchedulerTickWatchdog(Date.now() + DEFAULT_TICK_WATCHDOG_MS + 1);
    expect(result).toBe("unwedged");
    await vi.waitFor(() => expect(triggerMocks.drainMaterialEventQueue).toHaveBeenCalledTimes(2));
    expect(typeof db.getInternalSetting("scheduler:lastTick")).toBe("string");

    releaseDrain!();
    await first;
  });

  it("does not let the abandoned tick's finally clear a newer tick's in-flight guard", async () => {
    const { _runSchedulerTickForTest, runSchedulerTickWatchdog, DEFAULT_TICK_WATCHDOG_MS } =
      await import("../src/lib/scheduler");
    const resolvers: Array<() => void> = [];
    triggerMocks.drainMaterialEventQueue.mockImplementation(
      () => new Promise<void>((resolve) => { resolvers.push(resolve); })
    );

    const first = _runSchedulerTickForTest();
    await vi.waitFor(() => expect(resolvers.length).toBe(1));
    expect(runSchedulerTickWatchdog(Date.now() + DEFAULT_TICK_WATCHDOG_MS + 1)).toBe("unwedged");
    await vi.waitFor(() => expect(resolvers.length).toBe(2));
    expect(inFlight()).toBe(true);

    resolvers[0]!();
    await first;
    expect(inFlight()).toBe(true);

    triggerMocks.drainMaterialEventQueue.mockImplementation(() => Promise.resolve());
    resolvers[1]!();
    await vi.waitFor(() => expect(inFlight()).toBe(false));
  });

  it("opens Sentry as in_progress and closes ok when the tick finishes", async () => {
    vi.stubEnv("SENTRY_DSN", "https://public@example.ingest.sentry.io/1");
    vi.stubEnv("SENTRY_CRONS_ENABLED", "1");
    triggerMocks.drainMaterialEventQueue.mockImplementation(() => Promise.resolve());
    const { _runSchedulerTickForTest, SENTRY_CRON_MONITOR_SLUG } = await import("../src/lib/scheduler");
    await _runSchedulerTickForTest();
    const statuses = sentryMock.captureCheckIn.mock.calls.map(
      (call) => (call[0] as { status: string }).status
    );
    expect(SENTRY_CRON_MONITOR_SLUG).toBe("scheduler-tick");
    expect(statuses).toContain("in_progress");
    expect(statuses).toContain("ok");
    expect(statuses.indexOf("in_progress")).toBeLessThan(statuses.indexOf("ok"));
    expect(sentryMock.captureCheckIn.mock.calls.some(
      (call) => (call[0] as { status: string }).status === "ok" && (call[0] as { checkInId?: string }).checkInId === "check-in-id"
    )).toBe(true);
  });

  it("closes the in_progress Sentry check-in as error when the watchdog unwedges", async () => {
    vi.stubEnv("SENTRY_DSN", "https://public@example.ingest.sentry.io/1");
    vi.stubEnv("SENTRY_CRONS_ENABLED", "1");
    const { _runSchedulerTickForTest, runSchedulerTickWatchdog, DEFAULT_TICK_WATCHDOG_MS } =
      await import("../src/lib/scheduler");
    let releaseDrain: (() => void) | undefined;
    triggerMocks.drainMaterialEventQueue.mockImplementation(
      () => new Promise<void>((resolve) => { releaseDrain = resolve; })
    );

    const first = _runSchedulerTickForTest();
    await vi.waitFor(() => expect(triggerMocks.drainMaterialEventQueue).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(sentryMock.captureCheckIn.mock.calls.some(
        (call) => (call[0] as { status: string }).status === "in_progress"
      )).toBe(true)
    );

    triggerMocks.drainMaterialEventQueue.mockImplementation(() => Promise.resolve());
    expect(runSchedulerTickWatchdog(Date.now() + DEFAULT_TICK_WATCHDOG_MS + 1)).toBe("unwedged");
    await vi.waitFor(() =>
      expect(sentryMock.captureCheckIn.mock.calls.some(
        (call) => (call[0] as { status: string }).status === "error" && (call[0] as { checkInId?: string }).checkInId === "check-in-id"
      )).toBe(true)
    );

    releaseDrain!();
    await first;
  });
});
