/**
 * app/console/lib/api.ts — 401 -> /login redirect (board 30809a0c).
 *
 * Before this fix, a 401 from ANY console API call (the polled dashboard snapshot in
 * useConsoleData.tsx, or a one-off mutation through `request`) was handled exactly like a
 * network blip: a ConsoleApiError was thrown and the caller kept whatever last-good state it
 * had, with the freshness strip merely calling it "delayed". On a trading desk that is
 * dangerous — a dead session silently froze the dashboard on stale positions/orders that looked
 * live. Every console API call now routes a 401 through the SAME fail-closed destination
 * middleware.ts already uses for a page-level 401 (redirect to /login), instead of inventing a
 * second auth-redirect mechanism, and preserves the current location as `callbackUrl` so a
 * fresh sign-in returns the user where they were.
 *
 * `redirectToLogin` is module-private state (`redirectingToLogin`), so every test resets the
 * module via `vi.resetModules()` + a fresh dynamic import to avoid bleeding that flag across
 * tests (same pattern as test/policy-save-resilience.test.ts and friends).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function fakeWindow(pathname: string, search = "", hash = "") {
  return { location: { pathname, search, hash, href: "" } };
}

describe("console api client — 401 redirects to /login (not treated like a network blip)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the browser to /login with the current location as callbackUrl on a dashboard 401", async () => {
    const win = fakeWindow("/console/orders", "?tab=open");
    vi.stubGlobal("window", win);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })));

    const { fetchDashboard, ConsoleApiError, isRedirectingToLogin } = await import("../app/console/lib/api");

    await expect(fetchDashboard()).rejects.toBeInstanceOf(ConsoleApiError);
    expect(win.location.href).toBe(`/login?callbackUrl=${encodeURIComponent("/console/orders?tab=open")}`);
    expect(isRedirectingToLogin()).toBe(true);
  });

  it("redirects on a mutation 401 through the shared `request` wrapper too, not just the dashboard poll", async () => {
    const win = fakeWindow("/console/strategy");
    vi.stubGlobal("window", win);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        })
      )
    );

    const { runOnce } = await import("../app/console/lib/api");
    await expect(runOnce()).rejects.toMatchObject({ status: 401 });
    expect(win.location.href).toBe("/login?callbackUrl=%2Fconsole%2Fstrategy");
  });

  it("does not redirect on a non-401 error status (a 5xx/524 is still just a failed refresh)", async () => {
    const win = fakeWindow("/console");
    vi.stubGlobal("window", win);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));

    const { fetchDashboard } = await import("../app/console/lib/api");
    await expect(fetchDashboard()).rejects.toBeInstanceOf(Error);
    expect(win.location.href).toBe("");
  });

  it("never bounces from /login itself — a 401 reaching this client while already on /login is a no-op", async () => {
    const win = fakeWindow("/login");
    vi.stubGlobal("window", win);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })));

    const { fetchDashboard, isRedirectingToLogin } = await import("../app/console/lib/api");
    await expect(fetchDashboard()).rejects.toBeInstanceOf(Error);
    expect(win.location.href).toBe("");
    expect(isRedirectingToLogin()).toBe(false);
  });

  it("is idempotent: a second 401 while the navigation is already underway does not re-navigate", async () => {
    const win = fakeWindow("/console/orders");
    vi.stubGlobal("window", win);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })));

    const { fetchDashboard } = await import("../app/console/lib/api");
    await expect(fetchDashboard()).rejects.toBeInstanceOf(Error);
    expect(win.location.href).toBe("/login?callbackUrl=%2Fconsole%2Forders");

    // Clear href to make a SECOND navigation attempt detectable: if redirectToLogin ran again it
    // would recompute callbackUrl from the (unchanged) location and reassign href.
    win.location.href = "";
    await expect(fetchDashboard()).rejects.toBeInstanceOf(Error);
    expect(win.location.href).toBe(""); // still empty — the second 401 did not trigger another navigation
  });

  it("preserves the URL fragment in the login callback (fragment-driven views like #autonomy read it back)", async () => {
    const win = fakeWindow("/console/guardrails", "", "#autonomy");
    vi.stubGlobal("window", win);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })));

    const { fetchDashboard } = await import("../app/console/lib/api");
    await expect(fetchDashboard()).rejects.toBeInstanceOf(Error);
    expect(win.location.href).toBe(`/login?callbackUrl=${encodeURIComponent("/console/guardrails#autonomy")}`);
  });

  it("settings/lib.ts's separate request wrapper also redirects on a 401 through the shared redirectToLogin", async () => {
    const win = fakeWindow("/console/settings/brokers");
    vi.stubGlobal("window", win);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })));

    const { fetchSourceFeatures } = await import("../app/console/settings/lib");
    await expect(fetchSourceFeatures()).rejects.toMatchObject({ status: 401 });
    expect(win.location.href).toBe(`/login?callbackUrl=${encodeURIComponent("/console/settings/brokers")}`);
  });

  it("orders/api.ts's separate post wrapper also redirects on a 401 through the shared redirectToLogin", async () => {
    const win = fakeWindow("/console/orders");
    vi.stubGlobal("window", win);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })));

    const { cancelOrder } = await import("../app/console/orders/api");
    await expect(cancelOrder("order-1")).rejects.toMatchObject({ status: 401 });
    expect(win.location.href).toBe(`/login?callbackUrl=${encodeURIComponent("/console/orders")}`);
  });
});
