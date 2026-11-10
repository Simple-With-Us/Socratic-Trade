import { describe, expect, it } from "vitest";
import {
  ALPACA_ALLOWED_HOSTS,
  isPrivateOrReservedIp,
  validateBrokerBaseUrl,
  validateWebhookUrl
} from "../src/lib/egress-guard";

describe("validateBrokerBaseUrl — broker/MCP connection baseUrl (save-time SSRF guard)", () => {
  it("accepts every official Alpaca host over https", () => {
    for (const host of ALPACA_ALLOWED_HOSTS) {
      expect(validateBrokerBaseUrl(`https://${host}/v2`, ALPACA_ALLOWED_HOSTS)).toEqual({ ok: true });
    }
  });

  it("rejects http (even to an otherwise-allowed host)", () => {
    const result = validateBrokerBaseUrl("http://api.alpaca.markets/v2", ALPACA_ALLOWED_HOSTS);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/https/i);
  });

  it("rejects a host that is not in the allowlist", () => {
    const result = validateBrokerBaseUrl("https://evil.example.com/v2", ALPACA_ALLOWED_HOSTS);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not an allowed broker endpoint/i);
  });

  it("rejects a subdomain/typosquat that merely contains an allowed host string", () => {
    // A naive substring/endsWith check could be fooled by "api.alpaca.markets.evil.com" or
    // "notapi.alpaca.markets" — exact hostname match only.
    expect(validateBrokerBaseUrl("https://api.alpaca.markets.evil.com/v2", ALPACA_ALLOWED_HOSTS).ok).toBe(false);
    expect(validateBrokerBaseUrl("https://evilapi.alpaca.markets/v2", ALPACA_ALLOWED_HOSTS).ok).toBe(false);
  });

  it("rejects malformed URLs", () => {
    const result = validateBrokerBaseUrl("not a url", ALPACA_ALLOWED_HOSTS);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/valid URL/i);
  });

  it("rejects a private/loopback host even though it isn't in the allowlist either", () => {
    expect(validateBrokerBaseUrl("https://127.0.0.1/v2", ALPACA_ALLOWED_HOSTS).ok).toBe(false);
    expect(validateBrokerBaseUrl("https://169.254.169.254/latest/meta-data", ALPACA_ALLOWED_HOSTS).ok).toBe(false);
  });

  it("honors EGRESS_EXTRA_ALLOWED_HOSTS so the owner can add a host without a code change", () => {
    const original = process.env.EGRESS_EXTRA_ALLOWED_HOSTS;
    try {
      process.env.EGRESS_EXTRA_ALLOWED_HOSTS = "my-gateway.example.com, other.example.com";
      expect(validateBrokerBaseUrl("https://my-gateway.example.com/v2", ALPACA_ALLOWED_HOSTS)).toEqual({ ok: true });
      expect(validateBrokerBaseUrl("https://OTHER.EXAMPLE.COM/v2", ALPACA_ALLOWED_HOSTS)).toEqual({ ok: true }); // case-insensitive
      expect(validateBrokerBaseUrl("https://still-not-allowed.example.com/v2", ALPACA_ALLOWED_HOSTS).ok).toBe(false);
    } finally {
      if (original === undefined) delete process.env.EGRESS_EXTRA_ALLOWED_HOSTS;
      else process.env.EGRESS_EXTRA_ALLOWED_HOSTS = original;
    }
  });

  it("is case-insensitive on the host itself", () => {
    expect(validateBrokerBaseUrl("https://API.ALPACA.MARKETS/v2", ALPACA_ALLOWED_HOSTS)).toEqual({ ok: true });
  });
});

describe("isPrivateOrReservedIp", () => {
  it("flags IPv4 loopback, RFC1918, link-local/metadata, and documentation ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.5",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "169.254.0.1",
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "192.0.2.1", // TEST-NET-1
      "224.0.0.1", // multicast
      "255.255.255.255"
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it("does not flag public IPv4 addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1"]) {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  });

  it("flags IPv6 loopback, link-local, and unique-local", () => {
    expect(isPrivateOrReservedIp("::1")).toBe(true);
    expect(isPrivateOrReservedIp("fe80::1")).toBe(true);
    expect(isPrivateOrReservedIp("fc00::1")).toBe(true);
    expect(isPrivateOrReservedIp("fd12:3456:789a::1")).toBe(true);
  });

  it("does not flag a public IPv6 address", () => {
    expect(isPrivateOrReservedIp("2606:4700:4700::1111")).toBe(false); // Cloudflare DNS
  });

  it("unwraps IPv4-mapped IPv6 (::ffff:a.b.c.d) to check the embedded address — encoded-IP form", () => {
    expect(isPrivateOrReservedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:8.8.8.8")).toBe(false);
  });

  it("unwraps NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embedded IPv4 — more encoded-IP forms", () => {
    expect(isPrivateOrReservedIp("64:ff9b::169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIp("64:ff9b::8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIp("2002:a9fe:a9fe::")).toBe(true); // embeds 169.254.169.254
  });

  it("treats a non-IP-literal string as unsafe (never silently 'safe' on a parse failure)", () => {
    expect(isPrivateOrReservedIp("not-an-ip")).toBe(true);
  });
});

describe("validateWebhookUrl — user-configured notification webhook (SSRF guard)", () => {
  it("accepts a public address via an injected resolver (no real DNS needed)", async () => {
    const result = await validateWebhookUrl("https://hooks.example.com/x", { resolveHost: async () => ["8.8.8.8"] });
    expect(result).toEqual({ ok: true });
  });

  it("accepts http:// as well as https:// (the owner's own receiver may run either)", async () => {
    const result = await validateWebhookUrl("http://hooks.example.com/x", { resolveHost: async () => ["8.8.8.8"] });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-http(s) scheme", async () => {
    const result = await validateWebhookUrl("ftp://hooks.example.com/x");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/http/i);
  });

  it("rejects a malformed URL", async () => {
    const result = await validateWebhookUrl("not a url");
    expect(result.ok).toBe(false);
  });

  it("rejects the literal hostname 'localhost'", async () => {
    const result = await validateWebhookUrl("http://localhost:3000/hook");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/localhost/i);
  });

  it("rejects when every resolved address is private/loopback", async () => {
    const result = await validateWebhookUrl("https://internal.example.com/hook", {
      resolveHost: async () => ["10.0.0.5"]
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/private\/internal/i);
  });

  it("rejects the cloud metadata address specifically", async () => {
    const result = await validateWebhookUrl("https://metadata.example.com/hook", {
      resolveHost: async () => ["169.254.169.254"]
    });
    expect(result.ok).toBe(false);
  });

  it("rejects when ANY resolved address (of several, e.g. round-robin DNS) is private", async () => {
    const result = await validateWebhookUrl("https://mixed.example.com/hook", {
      resolveHost: async () => ["8.8.8.8", "127.0.0.1"]
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a literal private/loopback IP host directly (no DNS involved at all)", async () => {
    expect((await validateWebhookUrl("http://127.0.0.1:9999/x")).ok).toBe(false);
    expect((await validateWebhookUrl("http://169.254.169.254/latest/meta-data")).ok).toBe(false);
  });

  it("accepts a literal public IP host directly (no DNS involved at all)", async () => {
    expect((await validateWebhookUrl("https://8.8.8.8/hook")).ok).toBe(true);
  });

  it("rejects when DNS resolution fails outright", async () => {
    const result = await validateWebhookUrl("https://nowhere.example.com/hook", {
      resolveHost: async () => {
        throw new Error("ENOTFOUND");
      }
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not be resolved/i);
  });

  it("rejects when the resolver returns no addresses", async () => {
    const result = await validateWebhookUrl("https://empty.example.com/hook", { resolveHost: async () => [] });
    expect(result.ok).toBe(false);
  });

  it("DNS-rebind simulation: the same URL is re-validated fresh on every call, so a resolver that starts public and later answers private is caught on the later call", async () => {
    // Simulates an attacker changing DNS between save-time validation and a later send (or
    // between two sends): nothing here is cached across calls — each call resolves and checks
    // independently, which is the actual defense (see src/lib/notify.ts / notifications.ts
    // calling this immediately before every outbound fetch).
    let answer = "8.8.8.8";
    const rebindingResolver = async () => [answer];

    const first = await validateWebhookUrl("https://rebind.example.com/hook", { resolveHost: rebindingResolver });
    expect(first.ok).toBe(true);

    answer = "169.254.169.254"; // DNS record changed to point at cloud metadata
    const second = await validateWebhookUrl("https://rebind.example.com/hook", { resolveHost: rebindingResolver });
    expect(second.ok).toBe(false);
  });

  it("uses real DNS by default when no resolver is injected (production path)", async () => {
    // discord.com is a real, stable public host — this exercises the actual default resolver
    // wiring without a network mock, complementing the injected-resolver tests above.
    const result = await validateWebhookUrl("https://discord.com/api/webhooks/x");
    expect(result.ok).toBe(true);
  });
});
