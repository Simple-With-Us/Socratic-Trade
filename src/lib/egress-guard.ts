// Shared SSRF/egress-hardening guard for two distinct outbound-URL surfaces:
//
//   1. Broker `baseUrl` (connected-accounts): the server trusts this host with API
//      credentials, so it must be one of a small, fixed set of official broker hosts
//      (HTTPS only). The owner can extend the set — e.g. a self-hosted MCP gateway —
//      via the EGRESS_EXTRA_ALLOWED_HOSTS env var, without a code change.
//   2. User-configured notification webhooks: these legitimately point ANYWHERE public
//      (the owner's own receiver), so instead of a host allowlist we resolve DNS and
//      reject any address that lands in a private/loopback/link-local/metadata range —
//      the actual SSRF-relevant boundary for an arbitrary-destination fetch.
//
// Both checks are re-run at send time (not just at save time) so a value that was safe
// when saved but has since been rebound (DNS rebinding) or misconfigured is still caught
// immediately before the outbound request — see src/lib/notify.ts and
// src/lib/notifications.ts.

// Use bare "dns"/"net" (not "node:" scheme) so Next.js webpack can externalize them for
// server bundles. The "node:" URI scheme fails client/edge compilation when this module
// is pulled in transitively (notifications -> scheduler -> background-worker-startup).
import { promises as dns } from "dns";
import net from "net";

export interface EgressCheckResult {
  ok: boolean;
  error?: string;
}

// ── Broker baseUrl guard (sync — no DNS involved; a fixed host allowlist) ──────────────

/** Official Alpaca REST hosts a user-supplied connected-account `baseUrl` may target. */
export const ALPACA_ALLOWED_HOSTS: readonly string[] = [
  "api.alpaca.markets",
  "paper-api.alpaca.markets",
  "data.alpaca.markets"
];

/** Official Tradier hosts. Tradier's route already enforces an environment-matched host
 *  (see app/api/connected-accounts/route.ts); exported here so it can share the same
 *  allowlist mechanism/env override if that call site is ever consolidated. */
export const TRADIER_ALLOWED_HOSTS: readonly string[] = ["api.tradier.com", "sandbox.tradier.com"];

const EGRESS_EXTRA_ALLOWED_HOSTS_ENV = "EGRESS_EXTRA_ALLOWED_HOSTS";

function normalizeHostSet(hosts: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const raw of hosts) {
    const host = raw.trim().toLowerCase();
    if (host) out.add(host);
  }
  return out;
}

/** Extra owner-controlled broker hosts (e.g. a self-hosted MCP gateway), comma-separated.
 *  Lets the owner extend the broker baseUrl allowlist without a code change. */
export function extraAllowedBrokerHosts(): Set<string> {
  return normalizeHostSet((process.env[EGRESS_EXTRA_ALLOWED_HOSTS_ENV] ?? "").split(","));
}

/**
 * Validate a broker/MCP `baseUrl` supplied over the connected-accounts API: must be HTTPS
 * and its host must be in `allowedHosts` or in the EGRESS_EXTRA_ALLOWED_HOSTS env override.
 * Synchronous — no DNS lookup is needed for an exact-host allowlist match.
 */
export function validateBrokerBaseUrl(rawUrl: string, allowedHosts: readonly string[]): EgressCheckResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: "baseUrl must be a valid URL." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, error: "baseUrl must use https://." };
  }
  const host = url.hostname.toLowerCase();
  const allowed = normalizeHostSet(allowedHosts);
  const extra = extraAllowedBrokerHosts();
  if (allowed.has(host) || extra.has(host)) {
    return { ok: true };
  }
  const allowedList = [...allowed].join(", ");
  return {
    ok: false,
    error:
      `baseUrl host "${host}" is not an allowed broker endpoint (allowed: ${allowedList}` +
      `${extra.size ? `, or an ${EGRESS_EXTRA_ALLOWED_HOSTS_ENV} entry` : ""}). ` +
      `To use a different host (e.g. a self-hosted MCP gateway), add it to ${EGRESS_EXTRA_ALLOWED_HOSTS_ENV}.`
  };
}

// ── Webhook URL guard (async — resolves DNS and checks every returned address) ─────────

export type HostResolver = (hostname: string) => Promise<string[]>;

/** Real DNS resolution — the production default. A literal IP host resolves to itself
 *  with no network call. `verbatim: true` disables Node's reordering so every returned
 *  address (not just the first) is actually checked. */
async function defaultResolveHost(hostname: string): Promise<string[]> {
  if (net.isIP(hostname)) return [hostname];
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

function inIpv4Cidr(ip: string, base: string, prefixLen: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === undefined || baseInt === undefined) return false;
  if (prefixLen === 0) return true;
  const mask = prefixLen === 32 ? 0xffffffff : (~0 << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

// Private/loopback/link-local/reserved/documentation IPv4 ranges. Includes 169.254.0.0/16
// (link-local), which covers the cloud metadata address 169.254.169.254.
const IPV4_BLOCKED_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // shared/CGNAT address space
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1 (documentation)
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmark testing
  ["198.51.100.0", 24], // TEST-NET-2 (documentation)
  ["203.0.113.0", 24], // TEST-NET-3 (documentation)
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4] // reserved incl. 255.255.255.255
];

function isPrivateOrReservedIpv4(ip: string): boolean {
  return IPV4_BLOCKED_RANGES.some(([base, prefix]) => inIpv4Cidr(ip, base, prefix));
}

/** Expand a (possibly `::`-compressed) IPv6 address into 8 lowercase hex groups. Returns
 *  undefined if the input isn't a well-formed IPv6 address. Handles the trailing embedded-IPv4
 *  dotted-decimal form (e.g. `::ffff:169.254.169.254`, `64:ff9b::169.254.169.254`) by converting
 *  it to its two equivalent hex groups first — naively hex-splitting on `:` would otherwise treat
 *  "169.254.169.254" as a single non-hex "group" and silently misparse it. */
function expandIpv6Groups(ip: string): number[] | undefined {
  if (!net.isIPv6(ip)) return undefined;
  let normalized = ip;
  const lastColon = normalized.lastIndexOf(":");
  const lastSegment = normalized.slice(lastColon + 1);
  if (lastSegment.includes(".") && net.isIPv4(lastSegment)) {
    const v4Int = ipv4ToInt(lastSegment);
    if (v4Int === undefined) return undefined;
    const hi = ((v4Int >>> 16) & 0xffff).toString(16);
    const lo = (v4Int & 0xffff).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const [head, tail] = normalized.split("::");
  const parseGroups = (s: string): number[] => (s.length === 0 ? [] : s.split(":").map((g) => parseInt(g, 16)));
  let groups: number[];
  if (tail !== undefined) {
    const headGroups = parseGroups(head);
    const tailGroups = parseGroups(tail);
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return undefined;
    groups = [...headGroups, ...Array(missing).fill(0), ...tailGroups];
  } else {
    groups = parseGroups(head);
  }
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

function groupsToIpv4(g6: number, g7: number): string {
  return [(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff].join(".");
}

/** Rejects IPv6 loopback/unique-local/link-local, and unwraps IPv4-mapped (::ffff:0:0/96),
 *  NAT64 (64:ff9b::/96), and 6to4 (2002::/16) forms to re-check the embedded IPv4 address —
 *  the "encoded IP form" case an attacker could otherwise use to smuggle a metadata/loopback
 *  address past a naive string-based filter. */
function isPrivateOrReservedIpv6(ip: string): boolean {
  const groups = expandIpv6Groups(ip);
  if (!groups) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const isZero = (n: number) => n === 0;
  if ([g0, g1, g2, g3, g4, g5, g6].every(isZero) && g7 === 1) return true; // ::1 loopback
  if (groups.every(isZero)) return true; // :: unspecified
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateOrReservedIpv4(groupsToIpv4(g6, g7)); // ::ffff:a.b.c.d IPv4-mapped
  }
  if (g0 === 0x64 && g1 === 0xff9b && [g2, g3, g4, g5].every(isZero)) {
    return isPrivateOrReservedIpv4(groupsToIpv4(g6, g7)); // 64:ff9b::/96 NAT64
  }
  if (g0 === 0x2002) {
    return isPrivateOrReservedIpv4(groupsToIpv4(g1, g2)); // 2002::/16 6to4
  }
  return false;
}

/** True if `ip` (a literal IPv4 or IPv6 address, as returned by DNS resolution) is
 *  loopback / RFC1918 / link-local / documentation / metadata / otherwise non-public. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateOrReservedIpv4(ip);
  if (family === 6) return isPrivateOrReservedIpv6(ip);
  return true; // not a literal IP at all — never treat as safe
}

export interface WebhookValidationOptions {
  /** Injectable resolver for tests (DNS-rebind simulation, offline/hermetic runs). Defaults
   *  to real DNS via node:dns. */
  resolveHost?: HostResolver;
}

/**
 * Validate a user-configured webhook URL: http(s) only, and every address its host
 * resolves to must be public (not loopback/RFC1918/link-local/metadata/etc). Intended to
 * be called both when the URL is saved AND again immediately before every send (the
 * "re-validate on each send" defense against DNS rebinding — the resolved address is used
 * for validation only; the actual request should still be made with `redirect: "manual"`
 * so a 3xx response is never transparently followed to an unvalidated target).
 */
export async function validateWebhookUrl(rawUrl: string, options: WebhookValidationOptions = {}): Promise<EgressCheckResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: "webhookUrl must be a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "webhookUrl must use http:// or https://." };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname.toLowerCase() === "localhost") {
    return { ok: false, error: "webhookUrl must not target localhost." };
  }
  const resolve = options.resolveHost ?? defaultResolveHost;
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return { ok: false, error: `webhookUrl host "${hostname}" could not be resolved.` };
  }
  if (addresses.length === 0) {
    return { ok: false, error: `webhookUrl host "${hostname}" did not resolve to any address.` };
  }
  for (const address of addresses) {
    if (isPrivateOrReservedIp(address)) {
      return { ok: false, error: `webhookUrl host "${hostname}" resolves to a private/internal address and is not allowed.` };
    }
  }
  return { ok: true };
}
