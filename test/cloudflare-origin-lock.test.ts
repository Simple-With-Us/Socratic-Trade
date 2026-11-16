import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  CLOUDFLARE_IPV4_CIDRS,
  CLOUDFLARE_IPV6_CIDRS,
  isCloudflareIp,
  isLoopbackIp,
  isValidCidr,
  parseIp
} from "../src/lib/cloudflare-ip-ranges";
import {
  applyOriginLockToNodeRequest,
  applyOriginLockToUpgrade,
  clearOriginLockForTests,
  evaluateOriginLock,
  installOriginLock,
  middlewareOriginDecision,
  ORIGIN_CLIENT_IP_TRUST_HEADER,
  ORIGIN_PEER_STAMP_HEADER,
  setStampTokenForTests,
  uninstallOriginLockForTests,
  type OriginLockNodeRequest,
  type OriginLockNodeResponse
} from "../src/lib/cloudflare-origin-lock";
import { trustedCloudflareClientIp } from "../src/lib/rate-limit";

const ENV_KEYS = [
  "REQUIRE_CLOUDFLARE_ORIGIN",
  "ORIGIN_LOCK_SECRET",
  "ORIGIN_TRUSTED_PROXIES",
  "ORIGIN_LOCK_ALLOW_CIDRS"
] as const;

const CF_V4 = "104.16.0.1";
const CF_V6 = "2606:4700::1";
const PUBLIC = "203.0.113.8";
const PROXY = "10.0.1.5";
const SECRET = "origin-lock-test-secret-value";
const TOKEN = "a".repeat(64);

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  clearOriginLockForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  clearOriginLockForTests();
});

afterAll(() => {
  uninstallOriginLockForTests();
});

function enable(): void {
  process.env.REQUIRE_CLOUDFLARE_ORIGIN = "1";
}

function decide(overrides: Partial<Parameters<typeof evaluateOriginLock>[0]> = {}) {
  return evaluateOriginLock({
    method: "GET",
    pathname: "/console",
    socketPeer: PUBLIC,
    forwardedFor: null,
    xRealIp: null,
    originLockHeader: null,
    ...overrides
  });
}

function fakeRes(): OriginLockNodeResponse & { body: string } {
  return {
    statusCode: 200,
    body: "",
    setHeader() {},
    end(body?: string) {
      this.body = body ?? "";
    }
  };
}

function nodeReq(overrides: Partial<OriginLockNodeRequest> = {}): OriginLockNodeRequest {
  return {
    method: "GET",
    url: "/console",
    headers: {},
    socket: { remoteAddress: PUBLIC },
    ...overrides
  };
}

describe("cloudflare range matching", () => {
  it("accepts published ranges and rejects neighbours and private space", () => {
    for (const cidr of [...CLOUDFLARE_IPV4_CIDRS, ...CLOUDFLARE_IPV6_CIDRS]) {
      expect(isValidCidr(cidr)).toBe(true);
    }
    const inside = parseIp(CF_V4);
    const outside = parseIp("104.15.255.255");
    const v6 = parseIp(CF_V6);
    const v6out = parseIp("2606:4701::1");
    expect(inside && isCloudflareIp(inside)).toBe(true);
    expect(outside && isCloudflareIp(outside)).toBe(false);
    expect(parseIp("104.23.255.255") && isCloudflareIp(parseIp("104.23.255.255")!)).toBe(true);
    expect(v6 && isCloudflareIp(v6)).toBe(true);
    expect(v6out && isCloudflareIp(v6out)).toBe(false);
    expect(parseIp("::ffff:104.16.0.1") && isCloudflareIp(parseIp("::ffff:104.16.0.1")!)).toBe(true);
    for (const raw of ["10.1.2.3", "172.16.0.1", "192.168.1.1", "127.0.0.1", "100.64.1.1", "8.8.8.8"]) {
      const ip = parseIp(raw);
      expect(ip && isCloudflareIp(ip)).toBe(false);
    }
    expect(parseIp("127.0.0.2") && isLoopbackIp(parseIp("127.0.0.2")!)).toBe(true);
    expect(parseIp("::1") && isLoopbackIp(parseIp("::1")!)).toBe(true);
    expect(parseIp("::ffff:127.0.0.1") && isLoopbackIp(parseIp("::ffff:127.0.0.1")!)).toBe(true);
  });
});

describe("evaluateOriginLock", () => {
  it("allows every peer while the flag is off and does not mark headers trusted", () => {
    const decision = decide({
      forwardedFor: CF_V4,
      originLockHeader: SECRET
    });
    expect(decision).toMatchObject({ enabled: false, allow: true, trustClientHeaders: false, reason: "disabled" });
  });

  it("rejects a direct public peer even when forwarded headers name Cloudflare", () => {
    enable();
    const decision = decide({
      forwardedFor: `${PUBLIC}, ${CF_V4}`,
      xRealIp: CF_V4,
      originLockHeader: null
    });
    expect(decision).toMatchObject({ allow: false, trustClientHeaders: false, reason: "denied" });
  });

  it("accepts a direct Cloudflare TCP peer and trusts client IP headers", () => {
    enable();
    expect(decide({ socketPeer: CF_V4 })).toMatchObject({
      allow: true,
      trustClientHeaders: true,
      reason: "cloudflare-peer"
    });
    expect(decide({ socketPeer: `::ffff:${CF_V4}` }).reason).toBe("cloudflare-peer");
    expect(decide({ socketPeer: CF_V6 }).reason).toBe("cloudflare-peer");
  });

  it("accepts a trusted proxy only when the appended hop is Cloudflare", () => {
    enable();
    const allowed = decide({
      socketPeer: PROXY,
      forwardedFor: `198.51.100.20, ${CF_V4}`
    });
    expect(allowed).toMatchObject({ allow: true, trustClientHeaders: true, reason: "cloudflare-proxy" });

    const spoofed = decide({
      socketPeer: PROXY,
      forwardedFor: `${CF_V4}, ${PUBLIC}`,
      xRealIp: CF_V4
    });
    expect(spoofed.reason).toBe("denied");

    const realIpOnly = decide({
      socketPeer: "::ffff:172.18.0.2",
      xRealIp: CF_V4
    });
    expect(realIpOnly.reason).toBe("cloudflare-proxy");
  });

  it("does not treat a spoofed X-Real-IP as the hop when X-Forwarded-For already names the peer", () => {
    enable();
    const decision = decide({
      socketPeer: PROXY,
      forwardedFor: PUBLIC,
      xRealIp: CF_V4
    });
    expect(decision.reason).toBe("denied");
  });

  it("allows the liveness probe, loopback, and Tailscale without trusting client IP headers", () => {
    enable();
    expect(decide({ method: "GET", pathname: "/api/live", socketPeer: PUBLIC }).reason).toBe("health");
    expect(decide({ method: "HEAD", pathname: "/api/live/" }).trustClientHeaders).toBe(false);
    expect(decide({ method: "POST", pathname: "/api/live" }).reason).toBe("denied");
    expect(decide({ pathname: "/api/live/extra" }).reason).toBe("denied");
    expect(decide({ socketPeer: "127.0.0.1", pathname: "/console" })).toMatchObject({
      reason: "loopback",
      trustClientHeaders: false
    });
    expect(decide({ socketPeer: "100.64.8.8" }).reason).toBe("allowlist");
    expect(decide({ socketPeer: "100.128.0.1" }).reason).toBe("denied");
    process.env.ORIGIN_LOCK_ALLOW_CIDRS = "none";
    expect(decide({ socketPeer: "100.64.8.8" }).reason).toBe("denied");
  });

  it("accepts a matching origin secret and ignores a missing, short, or wrong one", () => {
    enable();
    process.env.ORIGIN_LOCK_SECRET = SECRET;
    expect(decide({ originLockHeader: SECRET })).toMatchObject({
      allow: true,
      trustClientHeaders: true,
      reason: "secret"
    });
    expect(decide({ originLockHeader: "origin-lock-test-secret-valuX" }).reason).toBe("denied");
    expect(decide({ originLockHeader: "" }).reason).toBe("denied");
    delete process.env.ORIGIN_LOCK_SECRET;
    expect(decide({ originLockHeader: SECRET }).reason).toBe("denied");
    process.env.ORIGIN_LOCK_SECRET = "too-short";
    expect(decide({ originLockHeader: "too-short" }).reason).toBe("denied");
  });
});

describe("node request hook", () => {
  it("strips spoofed client IP headers on loopback and keeps them for a Cloudflare hop", () => {
    enable();
    const loopback = nodeReq({
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        "cf-connecting-ip": PUBLIC,
        "x-forwarded-for": PUBLIC,
        "x-real-ip": PUBLIC,
        [ORIGIN_PEER_STAMP_HEADER]: "forged|1.1.1.1",
        [ORIGIN_CLIENT_IP_TRUST_HEADER]: "forged|1"
      }
    });
    const res = fakeRes();
    expect(applyOriginLockToNodeRequest(loopback, res)).toBe(true);
    expect(loopback.headers["cf-connecting-ip"]).toBeUndefined();
    expect(loopback.headers["x-forwarded-for"]).toBeUndefined();
    expect(loopback.headers["x-real-ip"]).toBeUndefined();
    expect(loopback.headers[ORIGIN_CLIENT_IP_TRUST_HEADER]).toBeUndefined();
    expect(String(loopback.headers[ORIGIN_PEER_STAMP_HEADER])).toMatch(/^[0-9a-f]{64}\|127\.0\.0\.1$/);
    expect(trustedCloudflareClientIp(new Request("https://socratictrade.com/console", {
      headers: { "cf-connecting-ip": PUBLIC }
    }))).toBeNull();

    const proxied = nodeReq({
      socket: { remoteAddress: PROXY },
      headers: {
        "cf-connecting-ip": "198.51.100.20",
        "x-forwarded-for": `198.51.100.20, ${CF_V4}`
      }
    });
    expect(applyOriginLockToNodeRequest(proxied, fakeRes())).toBe(true);
    expect(proxied.headers["cf-connecting-ip"]).toBe("198.51.100.20");
    const marker = String(proxied.headers[ORIGIN_CLIENT_IP_TRUST_HEADER]);
    expect(trustedCloudflareClientIp(new Request("https://socratictrade.com/console", {
      headers: {
        "cf-connecting-ip": "198.51.100.20",
        [ORIGIN_CLIENT_IP_TRUST_HEADER]: marker
      }
    }))).toBe("198.51.100.20");
  });

  it("returns 403 for a direct public request and does not continue an upgrade", () => {
    enable();
    const res = fakeRes();
    const req = nodeReq({
      headers: { "cf-connecting-ip": CF_V4, "x-forwarded-for": CF_V4 }
    });
    expect(applyOriginLockToNodeRequest(req, res)).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("Forbidden");

    let ended = "";
    expect(applyOriginLockToUpgrade(req, { end(chunk) { ended = chunk; } })).toBe(false);
    expect(ended).toContain("403");
  });

  it("leaves headers alone on a live server while the flag is off", async () => {
    const req = nodeReq({
      headers: { "cf-connecting-ip": PUBLIC, "x-forwarded-for": PUBLIC }
    });
    expect(applyOriginLockToNodeRequest(req, fakeRes())).toBe(true);
    expect(req.headers["cf-connecting-ip"]).toBe(PUBLIC);
    expect(trustedCloudflareClientIp(new Request("https://socratictrade.com/", {
      headers: { "cf-connecting-ip": "198.51.100.9" }
    }))).toBe("198.51.100.9");

    installOriginLock(http);
    let seen = "";
    const server = http.createServer((incoming, res) => {
      seen = String(incoming.headers["cf-connecting-ip"] ?? "");
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/console`, {
      headers: { "cf-connecting-ip": CF_V4 }
    });
    expect(response.status).toBe(200);
    expect(seen).toBe(CF_V4);
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("patches http.Server so a public emit is swallowed and loopback strips the header", async () => {
    enable();
    installOriginLock(http);
    let hit = 0;
    let seen: string | string[] | undefined = "unset";
    const server = http.createServer((req, res) => {
      hit += 1;
      seen = req.headers["cf-connecting-ip"];
      res.end("ok");
    });
    const denied = fakeRes();
    server.emit("request", nodeReq({
      headers: { "cf-connecting-ip": CF_V4 },
      socket: { remoteAddress: PUBLIC }
    }), denied);
    expect(hit).toBe(0);
    expect(denied.statusCode).toBe(403);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/console`, {
      headers: { "cf-connecting-ip": CF_V4 }
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(seen).toBeUndefined();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
});

describe("middleware origin decision", () => {
  it("defers when the flag is off or this runtime has no stamp token", () => {
    expect(middlewareOriginDecision({
      method: "GET",
      pathname: "/console",
      stamp: `${TOKEN}|${CF_V4}`,
      forwardedFor: null,
      xRealIp: null,
      originLockHeader: null
    })).toBe("defer");

    enable();
    expect(middlewareOriginDecision({
      method: "GET",
      pathname: "/console",
      stamp: `${TOKEN}|${CF_V4}`,
      forwardedFor: null,
      xRealIp: null,
      originLockHeader: null
    })).toBe("defer");
  });

  it("denies a forged stamp and allows a stamped Cloudflare proxy hop", async () => {
    enable();
    setStampTokenForTests(TOKEN);
    expect(middlewareOriginDecision({
      method: "GET",
      pathname: "/console",
      stamp: `b${TOKEN.slice(1)}|${CF_V4}`,
      forwardedFor: null,
      xRealIp: null,
      originLockHeader: null
    })).toBe("deny");

    expect(middlewareOriginDecision({
      method: "GET",
      pathname: "/console",
      stamp: `${TOKEN}|${PROXY}`,
      forwardedFor: `198.51.100.20, ${CF_V4}`,
      xRealIp: null,
      originLockHeader: null
    })).toBe("allow");

    expect(middlewareOriginDecision({
      method: "GET",
      pathname: "/api/live",
      stamp: null,
      forwardedFor: null,
      xRealIp: null,
      originLockHeader: null
    })).toBe("allow");

    const { middleware } = await import("../middleware");
    const denied = await middleware(new NextRequest("https://socratictrade.com/console", {
      headers: {
        [ORIGIN_PEER_STAMP_HEADER]: `forged|${CF_V4}`,
        "cf-connecting-ip": CF_V4,
        "x-forwarded-for": CF_V4
      }
    }));
    expect(denied.status).toBe(403);

    const allowed = await middleware(new NextRequest("https://socratictrade.com/console", {
      headers: {
        [ORIGIN_PEER_STAMP_HEADER]: `${TOKEN}|${CF_V4}`
      }
    }));
    expect(allowed.status).not.toBe(403);
  });
});
