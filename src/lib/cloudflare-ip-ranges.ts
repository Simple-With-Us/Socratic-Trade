// Cloudflare publishes the proxy ranges used to reach customer origins.
// Refresh the lists with `node scripts/refresh-cloudflare-ips.mjs`.
// Matching is pure TypeScript so the edge middleware bundle can import it.

import {
  CLOUDFLARE_IP_RANGES_RETRIEVED,
  CLOUDFLARE_IPV4_CIDRS,
  CLOUDFLARE_IPV6_CIDRS
} from "./cloudflare-ip-ranges.data";

export { CLOUDFLARE_IP_RANGES_RETRIEVED, CLOUDFLARE_IPV4_CIDRS, CLOUDFLARE_IPV6_CIDRS };

export interface ParsedIp {
  family: 4 | 6;
  bytes: Uint8Array;
}

interface ParsedCidr {
  family: 4 | 6;
  bytes: Uint8Array;
  prefix: number;
}

const cidrCache = new Map<string, ParsedCidr | null>();

function parseIpv4(raw: string): Uint8Array | null {
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (!part || !/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

function parseIpv6(raw: string): Uint8Array | null {
  if (raw.includes(".")) return null;
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (left.some((group) => group === "") || right.some((group) => group === "")) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
  } else if (missing < 0) {
    return null;
  }
  const groups = halves.length === 1 ? left : [...left, ...new Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i];
    if (!group || !/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

/** Parse an IP. IPv4-mapped IPv6 (`::ffff:a.b.c.d`) collapses to IPv4. */
export function parseIp(raw: string | null | undefined): ParsedIp | null {
  if (raw == null) return null;
  let value = raw.trim().toLowerCase();
  if (!value) return null;
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (value.startsWith("::ffff:") && value.includes(".")) {
    const mapped = parseIpv4(value.slice("::ffff:".length));
    if (mapped) return { family: 4, bytes: mapped };
    return null;
  }
  const v4 = parseIpv4(value);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = parseIpv6(value);
  if (v6) return { family: 6, bytes: v6 };
  return null;
}

export function formatIp(ip: ParsedIp): string {
  if (ip.family === 4) return [...ip.bytes].join(".");
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) {
    groups.push(((ip.bytes[i * 2] << 8) | ip.bytes[i * 2 + 1]).toString(16));
  }
  return groups.join(":");
}

function parseCidr(cidr: string): ParsedCidr | null {
  const cached = cidrCache.get(cidr);
  if (cached !== undefined) return cached;
  const slash = cidr.lastIndexOf("/");
  if (slash <= 0) {
    cidrCache.set(cidr, null);
    return null;
  }
  const ip = parseIp(cidr.slice(0, slash));
  const prefix = Number(cidr.slice(slash + 1));
  const max = ip?.family === 4 ? 32 : 128;
  if (!ip || !Number.isInteger(prefix) || prefix < 0 || prefix > max || String(prefix) !== cidr.slice(slash + 1)) {
    cidrCache.set(cidr, null);
    return null;
  }
  const parsed = { family: ip.family, bytes: ip.bytes, prefix };
  cidrCache.set(cidr, parsed);
  return parsed;
}

export function isValidCidr(cidr: string): boolean {
  return parseCidr(cidr.trim()) !== null;
}

function prefixMatch(ip: Uint8Array, network: Uint8Array, prefix: number): boolean {
  const full = Math.floor(prefix / 8);
  const rem = prefix % 8;
  for (let i = 0; i < full; i++) {
    if (ip[i] !== network[i]) return false;
  }
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (ip[full] & mask) === (network[full] & mask);
}

export function ipMatchesCidr(ip: ParsedIp, cidr: string): boolean {
  const parsed = parseCidr(cidr.trim());
  if (!parsed || parsed.family !== ip.family) return false;
  return prefixMatch(ip.bytes, parsed.bytes, parsed.prefix);
}

export function ipMatchesAnyCidr(ip: ParsedIp, cidrs: readonly string[]): boolean {
  for (const cidr of cidrs) {
    if (ipMatchesCidr(ip, cidr)) return true;
  }
  return false;
}

export function isCloudflareIp(ip: ParsedIp): boolean {
  const list = ip.family === 4 ? CLOUDFLARE_IPV4_CIDRS : CLOUDFLARE_IPV6_CIDRS;
  return ipMatchesAnyCidr(ip, list);
}

export function isLoopbackIp(ip: ParsedIp): boolean {
  if (ip.family === 4) return ip.bytes[0] === 127;
  for (let i = 0; i < 15; i++) {
    if (ip.bytes[i] !== 0) return false;
  }
  return ip.bytes[15] === 1;
}

/** Pull one IP out of an X-Forwarded-For token. Ports and brackets are ignored. */
export function parseForwardedToken(token: string): ParsedIp | null {
  let value = token.trim();
  if (!value || value.toLowerCase() === "unknown") return null;
  if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
    value = value.slice(1, -1).trim();
  }
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracket) return parseIp(bracket[1]);
  const v4Port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(value);
  if (v4Port) return parseIp(v4Port[1]);
  return parseIp(value);
}
