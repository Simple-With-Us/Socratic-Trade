/**
 * ST-4620: one tab keeps a single /api/dashboard fetch in flight.
 * A poll tick is skipped while that fetch is running, the fetch aborts when
 * the last subscriber aborts, and a slow response backs off the next poll.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDashboard } from "../app/console/lib/api";

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const request = await import("../app/console/lib/dashboard-request");
  request.resetDashboardRequestForTests();
});

describe("shared dashboard request", () => {
  it("never has two fetches in flight", async () => {
    const { loadSharedDashboard } = await import("../app/console/lib/dashboard-request");
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const pending = loadSharedDashboard(() => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        setTimeout(() => {
          active -= 1;
          resolve({ ok: true });
        }, 20);
      });
    });
    const joined = loadSharedDashboard(() => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      return Promise.resolve({ ok: false });
    });
    await expect(Promise.all([pending, joined])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(calls).toBe(1);
    expect(maxActive).toBe(1);
  });

  it("skips a poll tick while a request is in flight", async () => {
    const { loadSharedDashboard, shouldSkipDashboardPoll } = await import("../app/console/lib/dashboard-request");
    expect(shouldSkipDashboardPoll()).toBe(false);
    const pending = loadSharedDashboard(() => new Promise(() => {}));
    expect(shouldSkipDashboardPoll()).toBe(true);
    void pending.catch(() => {});
  });

  it("aborts the shared fetch when the last subscriber aborts", async () => {
    const { loadSharedDashboard, dashboardFetchInFlight } = await import("../app/console/lib/dashboard-request");
    const controller = new AbortController();
    let fetchAborted = false;
    const pending = loadSharedDashboard((signal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          fetchAborted = true;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchAborted).toBe(true);
    expect(dashboardFetchInFlight()).toBe(false);
  });

  it("keeps the shared fetch when another subscriber is still waiting", async () => {
    const { loadSharedDashboard } = await import("../app/console/lib/dashboard-request");
    const first = new AbortController();
    const second = new AbortController();
    let fetchAborted = false;
    let resolveFetch!: (value: { ok: boolean }) => void;
    const started = loadSharedDashboard((signal) => {
      signal.addEventListener("abort", () => {
        fetchAborted = true;
      });
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    }, first.signal);
    const joined = loadSharedDashboard(() => {
      throw new Error("second fetch started");
    }, second.signal);
    first.abort();
    await expect(started).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchAborted).toBe(false);
    resolveFetch({ ok: true });
    await expect(joined).resolves.toEqual({ ok: true });
  });

  it("backs off the next poll after a slow response", async () => {
    const { loadSharedDashboard, shouldSkipDashboardPoll, setDashboardRequestClockForTests } = await import(
      "../app/console/lib/dashboard-request"
    );
    let now = 1_700_000_000_000;
    setDashboardRequestClockForTests(() => now);
    await loadSharedDashboard(async () => {
      now += 9_000;
      return { ok: true };
    });
    expect(shouldSkipDashboardPoll(now)).toBe(true);
    expect(shouldSkipDashboardPoll(now + 8_999)).toBe(true);
    expect(shouldSkipDashboardPoll(now + 9_000)).toBe(false);
  });

  it("starts a fresh fetch when the shared request was already aborted", async () => {
    const { loadSharedDashboard } = await import("../app/console/lib/dashboard-request");
    const controller = new AbortController();
    let fetches = 0;
    const first = loadSharedDashboard((signal) => {
      fetches += 1;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
        setTimeout(() => resolve({ ok: false }), 1_000);
      });
    }, controller.signal);
    controller.abort();
    const second = loadSharedDashboard(() => {
      fetches += 1;
      return Promise.resolve({ ok: true });
    });
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toEqual({ ok: true });
    expect(fetches).toBe(2);
  });

  it("keeps a refresh waiter that joined the attempt which just finished", async () => {
    const { refreshWaitersReadyForAttempt } = await import("../app/console/lib/dashboard-request");
    const early = { seenAttempt: 1, id: "early" };
    const current = { seenAttempt: 2, id: "current" };
    const split = refreshWaitersReadyForAttempt([early, current], 2);
    expect(split.ready.map((waiter) => waiter.id)).toEqual(["early"]);
    expect(split.waiting.map((waiter) => waiter.id)).toEqual(["current"]);
  });
});

describe("fetchDashboard", () => {
  it("never has two requests in flight", async () => {
    let active = 0;
    let maxActive = 0;
    const fetchMock = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const [first, second] = await Promise.all([
      fetchDashboard<{ ok: boolean }>(),
      fetchDashboard<{ ok: boolean }>()
    ]);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(maxActive).toBe(1);
  });
});
