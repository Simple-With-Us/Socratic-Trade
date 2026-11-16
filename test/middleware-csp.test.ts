// ST-2789 — strict per-request nonce CSP.
//
// CSP stays off unless CSP_ENABLED is truthy, and report-only unless CSP_REPORT_ONLY
// is explicitly falsy.  The default script-src is nonce + strict-dynamic.  CSP_POLICY
// still replaces that string entirely.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest, NextResponse } from "next/server";
import { middleware, withSecurityHeaders } from "../middleware";
import { themeInitScript } from "../app/ui/theme";
import { pwaUnregisterScript } from "../src/lib/pwa-unregister";
import { LAYOUT_SCRIPT_HASHES, resolveCspDecision } from "../src/lib/csp-policy";
import { inlineScriptHashes } from "../scripts/csp-html-hashes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function directive(policy: string, name: string): string {
  return policy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `) || part === name) ?? "";
}

function nonceOf(policy: string): string {
  const match = directive(policy, "script-src").match(/'nonce-([^']+)'/);
  expect(match, policy).toBeTruthy();
  return match?.[1] ?? "";
}

function browserCsp(res: Response): { name: string; policy: string } {
  const enforcing = res.headers.get("Content-Security-Policy");
  const reportOnly = res.headers.get("Content-Security-Policy-Report-Only");
  if (enforcing && reportOnly) throw new Error("both CSP header names were set");
  if (enforcing) return { name: "Content-Security-Policy", policy: enforcing };
  if (reportOnly) return { name: "Content-Security-Policy-Report-Only", policy: reportOnly };
  throw new Error("no CSP header");
}

async function getLogin(): Promise<Response> {
  return middleware(new NextRequest("https://socratictrade.com/login"));
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, acc);
    else if (/\.(tsx|jsx)$/.test(entry.name)) acc.push(path);
  }
  return acc;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ST-2789 nonce CSP", () => {
  it("emits nothing when CSP_ENABLED is off, and drops a client-supplied nonce", async () => {
    vi.stubEnv("CSP_ENABLED", "");
    const res = await middleware(new NextRequest("https://socratictrade.com/login", {
      headers: { "x-nonce": "client-supplied-nonce" }
    }));
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
    expect(res.headers.get("Reporting-Endpoints")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-nonce")).toBeNull();
  });

  it("mints a unique nonce per request and forwards it as x-nonce", async () => {
    vi.stubEnv("CSP_ENABLED", "1");
    vi.stubEnv("NODE_ENV", "production");
    const first = browserCsp(await getLogin());
    const second = browserCsp(await getLogin());
    expect(first.name).toBe("Content-Security-Policy-Report-Only");
    expect(second.name).toBe("Content-Security-Policy-Report-Only");
    const nonceA = nonceOf(first.policy);
    const nonceB = nonceOf(second.policy);
    expect(nonceA).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(nonceB).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(nonceA).not.toBe(nonceB);

    const again = await getLogin();
    const policy = browserCsp(again).policy;
    const nonce = nonceOf(policy);
    expect(again.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(again.headers.get("x-middleware-request-content-security-policy")).toContain(`'nonce-${nonce}'`);
    const layoutHashes = LAYOUT_SCRIPT_HASHES.map((hash) => `'${hash}'`).join(" ");
    expect(directive(policy, "script-src")).toBe(
      `script-src 'self' 'nonce-${nonce}' ${layoutHashes} 'strict-dynamic'`
    );
    expect(directive(policy, "script-src")).not.toContain("unsafe-eval");
    expect(directive(policy, "script-src")).not.toContain("unsafe-inline");
    expect(directive(policy, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).toContain("report-uri /api/csp-report");
    expect(policy).toContain("report-to csp-endpoint");
    expect(again.headers.get("Reporting-Endpoints")).toBe('csp-endpoint="/api/csp-report"');
    expect(again.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("allows unsafe-eval only when NODE_ENV is development", async () => {
    vi.stubEnv("CSP_ENABLED", "1");
    vi.stubEnv("NODE_ENV", "development");
    const dev = directive(browserCsp(await getLogin()).policy, "script-src");
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).not.toContain("unsafe-inline");

    vi.stubEnv("NODE_ENV", "production");
    const prod = directive(browserCsp(await getLogin()).policy, "script-src");
    expect(prod).not.toContain("unsafe-eval");
  });

  it("flips the browser header to enforcing when CSP_REPORT_ONLY=0", async () => {
    vi.stubEnv("CSP_ENABLED", "1");
    vi.stubEnv("CSP_REPORT_ONLY", "0");
    vi.stubEnv("NODE_ENV", "production");
    const res = await getLogin();
    const got = browserCsp(res);
    expect(got.name).toBe("Content-Security-Policy");
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBeNull();
    expect(directive(got.policy, "script-src")).not.toContain("unsafe-eval");
    expect(directive(got.policy, "script-src")).toContain("'strict-dynamic'");
  });

  it("lets CSP_POLICY replace the nonce policy", async () => {
    vi.stubEnv("CSP_ENABLED", "yes");
    vi.stubEnv("CSP_POLICY", "default-src 'none'");
    const res = await middleware(new NextRequest("https://socratictrade.com/login", {
      headers: { "x-nonce": "client-supplied-nonce" }
    }));
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toBe("default-src 'none'");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("Reporting-Endpoints")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-nonce")).toBeNull();
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBeNull();
  });

  it("puts a fresh nonce on responses that do not render HTML", () => {
    vi.stubEnv("CSP_ENABLED", "1");
    vi.stubEnv("NODE_ENV", "production");
    const first = withSecurityHeaders(NextResponse.next());
    const second = withSecurityHeaders(NextResponse.next());
    const a = nonceOf(first.headers.get("Content-Security-Policy-Report-Only") ?? "");
    const b = nonceOf(second.headers.get("Content-Security-Policy-Report-Only") ?? "");
    expect(a).not.toBe(b);
    expect(directive(first.headers.get("Content-Security-Policy-Report-Only") ?? "", "script-src")).not.toContain("unsafe-eval");
  });

  it("keeps welcome, privacy, and terms report-only until the build stamps hashes", async () => {
    vi.stubEnv("CSP_ENABLED", "1");
    vi.stubEnv("CSP_REPORT_ONLY", "0");
    vi.stubEnv("NODE_ENV", "production");
    for (const path of ["/welcome", "/privacy-policy", "/terms-and-conditions"]) {
      const res = await middleware(new NextRequest(`https://socratictrade.com${path}`));
      const got = browserCsp(res);
      expect(got.name, path).toBe("Content-Security-Policy-Report-Only");
      expect(res.headers.get("Content-Security-Policy"), path).toBeNull();
      expect(directive(got.policy, "script-src"), path).toBe("script-src 'self' 'unsafe-inline'");
      expect(got.policy, path).not.toContain("strict-dynamic");
      expect(res.headers.get("x-middleware-request-x-nonce"), path).toBeNull();
    }
  });

  it("enforces a hash policy for a stamped static route and does not forward a nonce", () => {
    const decision = resolveCspDecision(
      "/privacy-policy",
      "unusednonceunusednonce00==",
      { NODE_ENV: "production", CSP_REPORT_ONLY: "0" },
      JSON.stringify({ "/privacy-policy": ["sha256-abc"] })
    );
    expect(decision.forwardNonce).toBe(false);
    expect(decision.headerName).toBe("Content-Security-Policy");
    expect(directive(decision.policy, "script-src")).toBe("script-src 'self' 'sha256-abc'");
    expect(directive(decision.policy, "script-src")).not.toContain("strict-dynamic");
    expect(directive(decision.policy, "script-src")).not.toContain("unsafe-inline");
    expect(directive(decision.policy, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
  });

  it("hashes the layout scripts and decodes inline HTML before hashing", () => {
    const sha = (text: string) => `sha256-${createHash("sha256").update(text).digest("base64")}`;
    expect(LAYOUT_SCRIPT_HASHES).toEqual([sha(themeInitScript), sha(pwaUnregisterScript)]);
    const html = '<script src="/app.js"></script><script>hello&amp;world</script><script>hello&amp;world</script>';
    expect(inlineScriptHashes(html)).toEqual([sha("hello&world")]);
  });

  it("covers every inline script and next/script under app/", () => {
    const files = walk(join(ROOT, "app"));
    const inline = files.filter((file) => /<script[\s>]/.test(readFileSync(file, "utf8")));
    expect(inline.map((file) => file.slice(ROOT.length + 1)).sort()).toEqual([
      "app/layout.tsx",
      "app/welcome/page.tsx"
    ]);
    const scriptImports = files.filter((file) => /from ["']next\/script["']/.test(readFileSync(file, "utf8")));
    expect(scriptImports).toEqual([]);
    const layout = readFileSync(join(ROOT, "app/layout.tsx"), "utf8");
    expect(layout).not.toContain("readRequestCspNonce");
    expect(layout).not.toContain('export const dynamic = "force-dynamic"');
    expect(layout).toContain("themeInitScript");
    expect(layout).toContain("pwaUnregisterScript");
    for (const page of ["app/welcome/page.tsx", "app/privacy-policy/page.tsx", "app/terms-and-conditions/page.tsx"]) {
      const text = readFileSync(join(ROOT, page), "utf8");
      expect(text, page).toContain("export const revalidate = 3600");
      expect(text, page).not.toContain("readRequestCspNonce");
    }
  });
});
