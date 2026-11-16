import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";

function createRequest(urlStr: string, hostHeader: string): NextRequest {
  return new NextRequest(urlStr, {
    headers: {
      host: hostHeader,
      "user-agent": "test-agent"
    }
  });
}

describe("middleware — subdomain routing for mobile and console", () => {
  it("redirects mobile.socratictrade.com/ to /console (PWA retired)", async () => {
    const req = createRequest("https://mobile.socratictrade.com/", "mobile.socratictrade.com");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://mobile.socratictrade.com/console");
  });

  it("redirects mobile.socratic.trade/settings to /console/settings", async () => {
    const req = createRequest("https://mobile.socratic.trade/settings", "mobile.socratic.trade");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://mobile.socratic.trade/console/settings");
  });

  it("redirects console.socratictrade.com/ to /console", async () => {
    const req = createRequest("https://console.socratictrade.com/", "console.socratictrade.com");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://console.socratictrade.com/console");
  });

  it("redirects console.socratic.trade/usage to /console/usage", async () => {
    const req = createRequest("https://console.socratic.trade/usage", "console.socratic.trade");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://console.socratic.trade/console/usage");
  });

  it("sends leftover /mobile paths on the mobile host to /console", async () => {
    const reqMobile = createRequest("https://mobile.socratictrade.com/mobile", "mobile.socratictrade.com");
    const resMobile = await middleware(reqMobile);
    expect(resMobile.status).toBe(307);
    expect(resMobile.headers.get("location")).toBe("https://mobile.socratictrade.com/console");

    const reqNested = createRequest("https://mobile.socratictrade.com/mobile/home", "mobile.socratictrade.com");
    const resNested = await middleware(reqNested);
    expect(resNested.status).toBe(307);
    expect(resNested.headers.get("location")).toBe("https://mobile.socratictrade.com/console");

    const reqConsole = createRequest("https://console.socratictrade.com/console", "console.socratictrade.com");
    const resConsole = await middleware(reqConsole);
    expect(resConsole.status).not.toBe(307);
  });

  // Board/codex finding on PR #3188: app/console/lib/api.ts's redirectToLogin does a plain
  // relative `window.location.href = "/login?callbackUrl=..."` navigation. Before this fix, that
  // request re-entered THIS middleware on console.socratictrade.com/mobile.socratictrade.com and
  // got rewritten to the protected /console/login (not a real route, and not public), which then
  // hit the page-level fail-closed redirect back to /login — which got rewritten to /console/login
  // again: an infinite loop that never reaches the sign-in page.
  it("does not rewrite /login into /console/login on console.socratictrade.com (would otherwise loop)", async () => {
    const req = createRequest("https://console.socratictrade.com/login", "console.socratictrade.com");
    const res = await middleware(req);
    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not rewrite /login into /console/login on mobile.socratictrade.com (would otherwise loop)", async () => {
    const req = createRequest("https://mobile.socratictrade.com/login", "mobile.socratictrade.com");
    const res = await middleware(req);
    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still rewrites other non-console paths on console.socratictrade.com (only /login is exempt)", async () => {
    const req = createRequest("https://console.socratictrade.com/watchlist", "console.socratictrade.com");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://console.socratictrade.com/console/watchlist");
  });
});
