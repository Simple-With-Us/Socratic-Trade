import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";

const REPO_ROOT = join(__dirname, "..");

function createRequest(urlStr: string, hostHeader: string): NextRequest {
  return new NextRequest(urlStr, {
    headers: {
      host: hostHeader,
      "user-agent": "test-agent"
    }
  });
}

/** Run `fn` with AUTH_SECRET forced on/off, restoring the previous value. */
async function withAuthSecret<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.AUTH_SECRET;
  if (value === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = prev;
  }
}

describe("middleware — public marketing host routing", () => {
  it("sends an anonymous visitor on the canonical domain to /welcome", async () => {
    // AUTH_SECRET on => auth is configured => no cookie means NO identity (the
    // dev/local fallback is disabled), which is the anonymous-visitor case.
    await withAuthSecret("test-secret-for-public-routing", async () => {
      const req = createRequest("https://socratictrade.com/", "socratictrade.com");
      const res = await middleware(req);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("https://socratictrade.com/welcome");
    });
  });

  it("sends a signed-in operator on the canonical domain to /console", async () => {
    // No AUTH_SECRET => the dev/local fallback identity stands in for a
    // session, so the operator keeps the console as their landing page.
    await withAuthSecret(undefined, async () => {
      const req = createRequest("https://socratictrade.com/", "socratictrade.com");
      const res = await middleware(req);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("https://socratictrade.com/console");
    });
  });

  it("forwards the alt domain to the canonical domain", async () => {
    const req = createRequest("https://socratic.trade/welcome", "socratic.trade");
    const res = await middleware(req);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://socratictrade.com/welcome");
  });

  it("forwards the alt domain's own root to the canonical welcome page", async () => {
    const req = createRequest("https://socratic.trade/", "socratic.trade");
    const res = await middleware(req);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://socratictrade.com/");
  });

  it("keeps the Apple associated-domain file on the alt domain", async () => {
    // applinks + webcredentials on socratic.trade need the AASA served on THAT
    // domain — redirecting it away would break the entitlement.
    const req = createRequest(
      "https://socratic.trade/.well-known/apple-app-site-association",
      "socratic.trade"
    );
    const res = await middleware(req);
    expect(res.status).not.toBe(308);
  });

  it("does not redirect /api/ on the alt domain (machine callers must not get a 308)", async () => {
    const req = createRequest("https://socratic.trade/api/live", "socratic.trade");
    const res = await middleware(req);
    expect(res.status).not.toBe(308);
  });

  it("leaves the console and admin subdomains of the alt domain alone", async () => {
    const consoleReq = createRequest("https://console.socratic.trade/", "console.socratic.trade");
    const consoleRes = await middleware(consoleReq);
    expect(consoleRes.status).toBe(307);
    expect(consoleRes.headers.get("location")).toBe("https://console.socratic.trade/console");

    const adminReq = createRequest("https://admin.socratic.trade/", "admin.socratic.trade");
    const adminRes = await middleware(adminReq);
    expect(adminRes.status).toBe(307);
    expect(adminRes.headers.get("location")).toBe("https://admin.socratic.trade/admin");
  });
});

describe("public site chrome — one shared shell for every public page", () => {
  const PUBLIC_PAGES = [
    "app/welcome/page.tsx",
    "app/framework/page.tsx",
    "app/terms-and-conditions/page.tsx",
    "app/privacy-policy/page.tsx"
  ];

  it.each(PUBLIC_PAGES)("%s renders through the shared PublicShell", (rel) => {
    // The owner asked for the animated wordmark to sit in the SAME place on
    // every public page. That only holds if every public page renders the one
    // shared header, so a page that grows its own header would silently move
    // the wordmark. This is a cheap source-level guard for that invariant.
    const src = readFileSync(join(REPO_ROOT, rel), "utf8");
    expect(src).toContain("ui/public/public-shell");
    expect(src).toContain("<PublicShell");
  });

  it("the welcome page links the Framework button at /framework and says Framework", () => {
    const src = readFileSync(join(REPO_ROOT, "app/welcome/page.tsx"), "utf8");
    expect(src).toContain('href="/framework"');
    // Whitespace-tolerant: the label must be exactly "Framework", not a
    // sentence-shaped variant that re-indenting would silently change.
    expect(src).toMatch(/>\s*Framework\s*<\/a>/);
    // The old label named only the decisions; the page is about the whole
    // framework now, so the old wording must not come back.
    expect(src).not.toContain("Decision framework");
  });

  it("the shared header's row height comes from the shared geometry constants", () => {
    // The loading animation computes its landing box from PUBLIC_BRAND_MAX_H and
    // PUBLIC_ROW_H. If the header's row height came from a Tailwind class instead
    // (or a min-height, which collapses when a page has no header action), the
    // row could render shorter than the animation assumes and the candles would
    // land a few pixels off the wordmark. Pin the row to the constant.
    const src = readFileSync(join(REPO_ROOT, "app/ui/public/public-shell.tsx"), "utf8");
    expect(src).toContain("height: PUBLIC_ROW_H");
    expect(src).toContain("PUBLIC_HEADER_PAD_Y");
    expect(src).not.toMatch(/min-h-8/);
  });
});
