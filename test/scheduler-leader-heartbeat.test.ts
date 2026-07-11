import { beforeEach, describe, expect, it, vi } from "vitest";

const schedulerMocks = vi.hoisted(() => ({
  acquireOrRenewLeadership: vi.fn(),
  markStaleRunningRuns: vi.fn(),
  setInternalSetting: vi.fn()
}));

vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return { ...actual, setInternalSetting: schedulerMocks.setInternalSetting };
});

vi.mock("../src/lib/db-execution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db-execution")>();
  return { ...actual, markStaleRunningRuns: schedulerMocks.markStaleRunningRuns };
});

vi.mock("../src/lib/scheduler-lease", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/scheduler-lease")>();
  return { ...actual, acquireOrRenewLeadership: schedulerMocks.acquireOrRenewLeadership };
});

import { _runSchedulerTickForTest } from "../src/lib/scheduler";

beforeEach(() => {
  vi.unstubAllEnvs();
  schedulerMocks.acquireOrRenewLeadership.mockReset();
  schedulerMocks.markStaleRunningRuns.mockReset().mockReturnValue(0);
  schedulerMocks.setInternalSetting.mockReset();
});

describe("scheduler leader heartbeat ordering", () => {
  it("does not refresh scheduler:lastTick when this process is only a follower", async () => {
    vi.stubEnv("SCHEDULER_SINGLE_LEADER", "1");
    schedulerMocks.acquireOrRenewLeadership.mockReturnValue(false);

    await _runSchedulerTickForTest();

    expect(schedulerMocks.markStaleRunningRuns).toHaveBeenCalledTimes(1);
    expect(schedulerMocks.acquireOrRenewLeadership).toHaveBeenCalledTimes(1);
    expect(schedulerMocks.setInternalSetting).not.toHaveBeenCalled();
  });
});
