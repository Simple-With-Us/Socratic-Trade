import { describe, expect, it } from "vitest";
import { checkSameOrigin, isStateChangingMethod } from "../src/lib/auth/csrf";

// CSRF same-origin guard (used by middleware.ts). State-changing same-origin requests pass; a browser
// signalling a cross-site context is rejected; non-browser callers (no Origin/Sec-Fetch-Site) fail-open.
describe("checkSameOrigin (CSRF guard)", () => {
  const base = {
    url: "https://trading.example.com/api/orders/cancel",
    host: "trading.example.com",
    forwardedHost: null as string | null,
    secFetchSite: null as string | null,
    origin: null as string | null,
    referer: null as string | null
  };

  it("allows safe (non-mutating) methods regardless of origin", () => {
    expect(isStateChangingMethod("GET")).toBe(false);
    const r = checkSameOrigin({ ...base, method: "GET", origin: "https://evil.example.net" });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("safe-method");
  });

  it("REJECTS a cross-site POST via Sec-Fetch-Site", () => {
    const r = checkSameOrigin({ ...base, method: "POST", secFetchSite: "cross-site" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("cross-site");
  });

  it("REJECTS a cross-origin POST via mismatched Origin host", () => {
    const r = checkSameOrigin({ ...base, method: "POST", origin: "https://evil.example.net" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("origin-mismatch");
  });

  it("REJECTS a cross-origin POST via mismatched Referer when Origin is absent", () => {
    const r = checkSameOrigin({ ...base, method: "POST", referer: "https://evil.example.net/page" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("referer-mismatch");
  });

  it("allows a same-origin POST via Sec-Fetch-Site: same-origin", () => {
    const r = checkSameOrigin({ ...base, method: "POST", secFetchSite: "same-origin" });
    expect(r.ok).toBe(true);
  });

  it("allows a same-origin POST via matching Origin host", () => {
    const r = checkSameOrigin({ ...base, method: "POST", origin: "https://trading.example.com" });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("origin-match");
  });

  it("prefers x-forwarded-host (tunnel/proxy) when matching Origin", () => {
    const r = checkSameOrigin({
      ...base,
      url: "http://internal:3000/api/orders/cancel",
      host: "internal:3000",
      forwardedHost: "trading.example.com",
      method: "POST",
      origin: "https://trading.example.com"
    });
    expect(r.ok).toBe(true);
  });

  it("fails OPEN for non-browser callers (no Origin / Sec-Fetch-Site) — server-to-server, curl, webhooks", () => {
    const r = checkSameOrigin({ ...base, method: "POST" });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("no-browser-origin-signal");
  });

  it("treats Sec-Fetch-Site: none (user-initiated) as safe", () => {
    const r = checkSameOrigin({ ...base, method: "POST", secFetchSite: "none" });
    expect(r.ok).toBe(true);
  });
});
