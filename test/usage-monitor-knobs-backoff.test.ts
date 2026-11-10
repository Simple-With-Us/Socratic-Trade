/**
 * Negative-result backoff for the usage-monitor knob cache (2026-08-02 prod-wedge amplifier):
 * a dead/unreachable monitor previously made EVERY knob read re-enter triggerRefresh — one
 * fetch + one sync logApiHealth DB transaction per provider admission. A failed refresh must
 * now stamp a failure marker and suppress re-attempts for KNOBS_FAILURE_BACKOFF_MS.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const priorReadToken = process.env.USAGE_READ_TOKEN;

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-umknobs-${randomUUID()}.db`)}`;
});

beforeEach(async () => {
  process.env.USAGE_MONITOR_BASE_URL = "http://127.0.0.1:1"; // never reached — fetchImpl injected
  process.env.USAGE_READ_TOKEN = "test-dummy-value"; // fetchKnobMap requires this before it will call fetchImpl
  delete process.env.USAGE_MONITOR_KNOBS_ENABLED;
  const { resetUsageMonitorKnobsCacheForTests } = await import("../src/lib/usage-monitor-knobs");
  const { resetPeerLaneBackoffForTests } = await import("../src/lib/peer-lane-backoff");
  resetUsageMonitorKnobsCacheForTests();
  resetPeerLaneBackoffForTests();
});

afterEach(async () => {
  delete process.env.USAGE_MONITOR_BASE_URL;
  if (priorReadToken === undefined) delete process.env.USAGE_READ_TOKEN;
  else process.env.USAGE_READ_TOKEN = priorReadToken;
  const { resetUsageMonitorKnobsCacheForTests } = await import("../src/lib/usage-monitor-knobs");
  const { resetPeerLaneBackoffForTests } = await import("../src/lib/peer-lane-backoff");
  resetUsageMonitorKnobsCacheForTests();
  resetPeerLaneBackoffForTests();
  vi.useRealTimers();
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("usage-monitor knob failure backoff", () => {
  it("a failed refresh suppresses re-attempts within the backoff window, then retries after it", async () => {
    const { getUsageMonitorKnobsCached, KNOBS_FAILURE_BACKOFF_MS } = await import("../src/lib/usage-monitor-knobs");
    const failingFetch = vi.fn().mockRejectedValue(new Error("monitor down"));

    getUsageMonitorKnobsCached({ fetchImpl: failingFetch as unknown as typeof fetch });
    await flush(); // let the fire-and-forget refresh settle and stamp the failure
    const callsAfterFirst = failingFetch.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    // Hammer the sync getter the way provider admissions do — no further fetches may fire.
    for (let i = 0; i < 50; i += 1) {
      getUsageMonitorKnobsCached({ fetchImpl: failingFetch as unknown as typeof fetch });
    }
    await flush();
    expect(failingFetch.mock.calls.length).toBe(callsAfterFirst);

    // Past the backoff window a retry is allowed again.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + KNOBS_FAILURE_BACKOFF_MS + 1_000);
    getUsageMonitorKnobsCached({ fetchImpl: failingFetch as unknown as typeof fetch });
    vi.useRealTimers();
    await flush();
    expect(failingFetch.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("a successful refresh clears the failure marker and stamps the cache", async () => {
    const { getUsageMonitorKnobsCached } = await import("../src/lib/usage-monitor-knobs");
    const okFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ knobs: { SOME_KNOB: "42" } }), { status: 200, headers: { "content-type": "application/json" } })
    );
    getUsageMonitorKnobsCached({ fetchImpl: okFetch as unknown as typeof fetch });
    await flush();
    // Cache now populated (visible on the NEXT call per stale-while-revalidate contract) and no
    // repeat fetch inside the TTL.
    const calls = okFetch.mock.calls.length;
    getUsageMonitorKnobsCached({ fetchImpl: okFetch as unknown as typeof fetch });
    await flush();
    expect(okFetch.mock.calls.length).toBe(calls);
  });

  it("a slow-but-200 monitor (p50 > 2s) suppresses further refreshes — #2550", async () => {
    const { getUsageMonitorKnobsCached } = await import("../src/lib/usage-monitor-knobs");
    const { recordPeerLaneSample, PEER_LANE_USAGE_MONITOR } = await import("../src/lib/peer-lane-backoff");
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, 6900);
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, 7100);
    const okFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } })
    );
    getUsageMonitorKnobsCached({ fetchImpl: okFetch as unknown as typeof fetch });
    await flush();
    expect(okFetch).not.toHaveBeenCalled();
  });
});
