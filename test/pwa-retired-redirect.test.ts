import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";
import { clearStalePwaState, pwaUnregisterScript } from "../src/lib/pwa-unregister";

function request(path: string, host = "socratictrade.com"): NextRequest {
  return new NextRequest(`https://${host}${path}`, {
    headers: { host, "user-agent": "test-agent" }
  });
}

describe("PWA retired", () => {
  it("/mobile page redirects to /console", async () => {
    const MobilePage = (await import("../app/mobile/page")).default;
    let digest = "";
    try {
      MobilePage();
    } catch (err) {
      digest = String((err as { digest?: string })?.digest ?? err);
    }
    expect(digest).toContain("NEXT_REDIRECT");
    expect(digest).toContain("/console");
  });

  it("middleware sends leftover /mobile paths on the apex host to /console", async () => {
    const res = await middleware(request("/mobile"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://socratictrade.com/console");

    const nested = await middleware(request("/mobile/approvals"));
    expect(nested.status).toBe(307);
    expect(nested.headers.get("location")).toBe("https://socratictrade.com/console");
  });

  it("does not intercept native iOS /api/mobile routes as a PWA redirect", async () => {
    const res = await middleware(request("/api/mobile/snapshot"));
    expect(res.headers.get("location") ?? "").not.toContain("/console");
  });

  it("returns 410 for the retired web app manifest", async () => {
    const res = await middleware(request("/manifest.webmanifest"));
    expect(res.status).toBe(410);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("does not advertise an installable PWA in root metadata", async () => {
    const src = await readFile(path.join(process.cwd(), "app/layout.tsx"), "utf8");
    expect(src).toContain("appleWebApp: false");
    expect(src).not.toContain("manifest.webmanifest");
    expect(src).toContain("pwaUnregisterScript");
  });

  it("removed the standalone manifest module and PWA client tree", () => {
    const root = process.cwd();
    expect(existsSync(path.join(root, "app/manifest.ts"))).toBe(false);
    expect(existsSync(path.join(root, "app/mobile/mobile-pwa-client.tsx"))).toBe(false);
    expect(existsSync(path.join(root, "app/mobile/components/MobileHomeTab.tsx"))).toBe(false);
    expect(existsSync(path.join(root, "app/mobile/page.tsx"))).toBe(true);
  });

  it("unregisters leftover service workers and drops Cache Storage", async () => {
    const unregistered: string[] = [];
    const deleted: string[] = [];
    const result = await clearStalePwaState({
      getRegistrations: async () => [
        {
          unregister: async () => {
            unregistered.push("sw");
            return true;
          }
        }
      ],
      cacheKeys: async () => ["workbox-precache", "next-pwa"],
      deleteCache: async (key) => {
        deleted.push(key);
        return true;
      }
    });
    expect(result).toEqual({ unregistered: 1, cachesCleared: 2 });
    expect(unregistered).toEqual(["sw"]);
    expect(deleted).toEqual(["workbox-precache", "next-pwa"]);
    expect(pwaUnregisterScript).toContain("serviceWorker");
    expect(pwaUnregisterScript).toContain("unregister");
    expect(pwaUnregisterScript).toContain("caches.delete");
  });
});
