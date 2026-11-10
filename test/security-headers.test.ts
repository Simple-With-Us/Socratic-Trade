// G4 — Security response headers.
//
// middleware.ts now sets X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
// Permissions-Policy, and Strict-Transport-Security (production only) on EVERY returned
// response, and a CSP that is DEFAULT-OFF (only emitted when CSP_ENABLED is truthy) and
// report-only unless CSP_REPORT_ONLY is explicitly off. Middleware is awkward to unit-test
// end-to-end (edge runtime, session verification), so we assert the exported
// `withSecurityHeaders` helper that builds the header set for each response.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { withSecurityHeaders } from "../middleware";

afterEach(() => vi.unstubAllEnvs());

describe("G4: withSecurityHeaders", () => {
  it("always sets X-Frame-Options, X-Content-Type-Options, Referrer-Policy, and Permissions-Policy, with CSP OFF by default", () => {
    const res = withSecurityHeaders(NextResponse.next());
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("Permissions-Policy")).toContain("camera=()");
    // No CSP env → neither CSP header is set (can't break the dashboard's inline/eval/Next resources).
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
    // HSTS is production-only; dev/non-prod gets no HSTS header.
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("sets Strict-Transport-Security in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = withSecurityHeaders(NextResponse.next());
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains; preload");
  });

  it("emits a REPORT-ONLY CSP when CSP_ENABLED is on (default report-only)", () => {
    vi.stubEnv("CSP_ENABLED", "1");
    const res = withSecurityHeaders(NextResponse.next());
    const policy = res.headers.get("Content-Security-Policy-Report-Only");
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("report-uri /api/csp-report");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("emits an ENFORCING CSP only when CSP_REPORT_ONLY is explicitly off", () => {
    vi.stubEnv("CSP_ENABLED", "true");
    vi.stubEnv("CSP_REPORT_ONLY", "off");
    const res = withSecurityHeaders(NextResponse.next());
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
  });

  it("honors a custom CSP_POLICY override", () => {
    vi.stubEnv("CSP_ENABLED", "yes");
    vi.stubEnv("CSP_POLICY", "default-src 'none'");
    const res = withSecurityHeaders(NextResponse.next());
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBe("default-src 'none'");
  });

  it("sets the headers on 401/403 responses too (applied to all returned responses)", () => {
    const res = withSecurityHeaders(new NextResponse("Unauthorized", { status: 401 }));
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });
});
