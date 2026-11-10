import { describe, expect, it, vi } from "vitest";
import {
  resolveBackgroundWorkerDecision,
  startServerBackgroundWorkers,
  type BackgroundWorkerStarters,
} from "../src/lib/background-worker-startup";

const congressProbe = vi.hoisted(() => ({
  token: vi.fn<() => string | undefined>(),
  startup: vi.fn<() => Promise<void>>(),
}));
vi.mock("../src/lib/congress-share", () => ({
  congressTradeToken: congressProbe.token,
  probeCongressShareTokenOnStartup: congressProbe.startup,
}));

function starterSpies(): BackgroundWorkerStarters {
  return {
    startScheduler: vi.fn(),
    startUsageMonitorReplay: vi.fn(),
    startServerKnobSupervisor: vi.fn(),
    startStreams: vi.fn(),
    startSecIngestWorker: vi.fn(),
  };
}

describe("background worker boot decision", () => {
  it("keeps production workers on by default, even if the dev-only flag is false", () => {
    expect(resolveBackgroundWorkerDecision({ NODE_ENV: "production" })).toEqual({
      enabled: true,
      environment: "production",
      reason: "production-default",
    });
    expect(resolveBackgroundWorkerDecision({
      NODE_ENV: "production",
      DEV_BACKGROUND_WORKERS: "off",
    }).enabled).toBe(true);
  });

  it.each([
    [{ NODE_ENV: "development" }, "development"],
    [{ NODE_ENV: "test" }, "test"],
    [{ VITEST: "true" }, "test"],
    [{ NODE_ENV: "production", VITEST: "true" }, "test"],
    [{}, "unknown"],
    [{ NODE_ENV: "development", DEV_BACKGROUND_WORKERS: "invalid" }, "development"],
  ] as const)("fails closed outside production for %o", (env, environment) => {
    expect(resolveBackgroundWorkerDecision(env)).toEqual({
      enabled: false,
      environment,
      reason: "non-production-default-off",
    });
  });

  it.each(["1", "true", "ON", " yes "])("accepts the explicit non-production opt-in %j", (value) => {
    expect(resolveBackgroundWorkerDecision({
      NODE_ENV: "development",
      DEV_BACKGROUND_WORKERS: value,
    })).toEqual({
      enabled: true,
      environment: "development",
      reason: "non-production-opt-in",
    });
  });
});

describe("background worker startup", () => {
  it("does not invoke any worker starter in ordinary development", async () => {
    const starters = starterSpies();
    const log = vi.fn();

    await expect(startServerBackgroundWorkers({
      env: { NODE_ENV: "development" },
      starters,
      log,
    })).resolves.toMatchObject({ enabled: false });

    expect(starters.startScheduler).not.toHaveBeenCalled();
    expect(starters.startUsageMonitorReplay).not.toHaveBeenCalled();
    expect(starters.startServerKnobSupervisor).not.toHaveBeenCalled();
    expect(starters.startStreams).not.toHaveBeenCalled();
    expect(starters.startSecIngestWorker).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("disabled (development"));
  });

  it("claims the unconditional boot probe before starting the scheduler", async () => {
    congressProbe.token.mockReturnValue("test-token");
    congressProbe.startup.mockResolvedValue(undefined);
    const starters = starterSpies();
    vi.mocked(starters.startScheduler).mockImplementation(() => {
      expect(congressProbe.startup).toHaveBeenCalledTimes(1);
    });
    await startServerBackgroundWorkers({
      env: { NODE_ENV: "production" }, starters, log: vi.fn(),
    });
    expect(congressProbe.startup).toHaveBeenCalledTimes(1);
    congressProbe.token.mockReset();
    congressProbe.startup.mockReset();
  });

  it("starts every worker family once after an explicit development opt-in", async () => {
    const starters = starterSpies();
    const log = vi.fn();
    let replayBoundaryReady = false;
    vi.mocked(starters.startUsageMonitorReplay).mockImplementation(() => {
      replayBoundaryReady = true;
    });
    vi.mocked(starters.startScheduler).mockImplementation(() => {
      expect(replayBoundaryReady).toBe(true);
    });

    await expect(startServerBackgroundWorkers({
      env: { NODE_ENV: "development", DEV_BACKGROUND_WORKERS: "on" },
      starters,
      log,
    })).resolves.toMatchObject({ enabled: true, reason: "non-production-opt-in" });

    expect(starters.startScheduler).toHaveBeenCalledTimes(1);
    expect(starters.startUsageMonitorReplay).toHaveBeenCalledTimes(1);
    expect(starters.startServerKnobSupervisor).toHaveBeenCalledTimes(1);
    expect(starters.startStreams).toHaveBeenCalledTimes(1);
    expect(starters.startSecIngestWorker).toHaveBeenCalledTimes(1);
    expect(vi.mocked(starters.startUsageMonitorReplay).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(starters.startScheduler).mock.invocationCallOrder[0]!);
    // The knob supervisor must precede startStreams: it registers the congress-stream enabled
    // resolver the boot gate consults (see server-knob-supervisor.ts).
    expect(vi.mocked(starters.startServerKnobSupervisor).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(starters.startStreams).mock.invocationCallOrder[0]!);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("enabled (development"));
  });
});
