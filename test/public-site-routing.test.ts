import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";
import { encodeSessionToken } from "../src/lib/auth/session-token";

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

  it("the alt-domain 308 carries the standard security headers", async () => {
    // G4 (docs/rollouts/2026-07-01-security-hardening.md): every response the
    // middleware returns goes out through withSecurityHeaders. A redirect is
    // still a response a browser renders, so the redirect must carry them too.
    const req = createRequest("https://socratic.trade/welcome", "socratic.trade");
    const res = await middleware(req);
    expect(res.status).toBe(308);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("Permissions-Policy")).toContain("camera=()");
  });

  it("keeps a signed-in operator on the alt domain instead of dropping their session", async () => {
    // The Auth.js cookie is host-only by default, and socratic.trade and
    // socratictrade.com are unrelated domains, so no cookie domain can span
    // them. A 308 to the canonical host therefore never carries the session,
    // and the operator lands on the public landing page instead of the console.
    // Only anonymous traffic may be forwarded.
    const secret = "test-secret-for-alt-domain-session";
    await withAuthSecret(secret, async () => {
      const token = await encodeSessionToken({
        token: { email: "operator@example.com" },
        secret,
        salt: "authjs.session-token"
      });
      const req = new NextRequest("https://socratic.trade/", {
        headers: {
          host: "socratic.trade",
          "user-agent": "test-agent",
          cookie: `authjs.session-token=${token}`
        }
      });
      const res = await middleware(req);
      expect(res.status).not.toBe(308);
      expect(res.headers.get("location")).toBe("https://socratic.trade/console");
    });
  });

  it("still forwards anonymous traffic on the alt domain to the canonical host", async () => {
    // The session guard must not turn the alt domain into a second canonical
    // host: a visitor with no session is still forwarded.
    await withAuthSecret("test-secret-for-alt-domain-session", async () => {
      const req = createRequest("https://socratic.trade/welcome", "socratic.trade");
      const res = await middleware(req);
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe("https://socratictrade.com/welcome");
    });
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

describe("the public host map — one shared module", () => {
  it("the middleware and the apex route both read the host sets from the shared module", () => {
    // The host sets used to be written out twice. A second copy compiles fine
    // and type-checks fine, so the only way it fails is by drifting — the
    // middleware sends a visitor one way and the route sends them another. Pin
    // the single source of truth.
    const shared = readFileSync(join(REPO_ROOT, "src/lib/marketing-hosts.ts"), "utf8");
    expect(shared).toContain("socratictrade.com");
    expect(shared).toContain("socratic.trade");

    const mw = readFileSync(join(REPO_ROOT, "middleware.ts"), "utf8");
    expect(mw).toContain('from "./src/lib/marketing-hosts"');
    expect(mw).not.toMatch(/const MARKETING_HOSTS/);
    expect(mw).not.toMatch(/const ALT_DOMAIN_HOSTS/);

    const page = readFileSync(join(REPO_ROOT, "app/page.tsx"), "utf8");
    expect(page).toContain('from "@/lib/marketing-hosts"');
    expect(page).not.toMatch(/const MARKETING_HOSTS/);
  });
});

describe("landing-page off-switch — the marketing pages honor LANDING_PAGE_ENABLED", () => {
  /** Run `fn` with LANDING_PAGE_ENABLED forced to `value`, restoring the previous value. */
  async function withLandingPage<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.LANDING_PAGE_ENABLED;
    if (value === undefined) delete process.env.LANDING_PAGE_ENABLED;
    else process.env.LANDING_PAGE_ENABLED = value;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.LANDING_PAGE_ENABLED;
      else process.env.LANDING_PAGE_ENABLED = prev;
    }
  }

  it("sends an anonymous visitor to /login, not to a /welcome that would 404", async () => {
    // Regression guard: the apex redirect to /welcome used to be unconditional.
    // With the marketing pages switched off, /welcome 404s, so that redirect
    // turned the apex into a dead end instead of the login page.
    await withAuthSecret("test-secret-for-public-routing", async () => {
      await withLandingPage("off", async () => {
        const req = createRequest("https://socratictrade.com/", "socratictrade.com");
        const res = await middleware(req);
        const location = res.headers.get("location") || "";
        expect(location).toContain("/login");
        expect(location).not.toContain("/welcome");
      });
    });
  });

  it("still sends a signed-in operator to /console with the pages switched off", async () => {
    // The off-switch hides the marketing pages from visitors; it must not log
    // the operator out of their own console.
    await withAuthSecret(undefined, async () => {
      await withLandingPage("off", async () => {
        const req = createRequest("https://socratictrade.com/", "socratictrade.com");
        const res = await middleware(req);
        expect(res.headers.get("location")).toBe("https://socratictrade.com/console");
      });
    });
  });

  it("keeps sending an anonymous visitor to /welcome while the pages are on", async () => {
    await withAuthSecret("test-secret-for-public-routing", async () => {
      await withLandingPage(undefined, async () => {
        const req = createRequest("https://socratictrade.com/", "socratictrade.com");
        const res = await middleware(req);
        expect(res.headers.get("location")).toBe("https://socratictrade.com/welcome");
      });
    });
  });

  it("the /framework page inherits the off-switch", async () => {
    // /framework absorbed the retired /how-it-works page, which was gated. If
    // the gate stayed behind, LANDING_PAGE_ENABLED=off would take /welcome down
    // and leave the page that replaced its content wide open.
    const src = readFileSync(join(REPO_ROOT, "app/framework/page.tsx"), "utf8");
    expect(src).toContain("landingPageEnabled");
    expect(src).toContain("notFound()");
  });

  it("the apex route consults the off-switch before redirecting to /welcome", async () => {
    const src = readFileSync(join(REPO_ROOT, "app/page.tsx"), "utf8");
    expect(src).toContain("landingPageEnabled");
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
