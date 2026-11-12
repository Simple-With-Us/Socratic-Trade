// Request-level Cloudflare origin lock (ST-4595 / sec-02).
//
// Default OFF (`REQUIRE_CLOUDFLARE_ORIGIN` unset). Turning it on rejects traffic
// whose TCP peer is not Cloudflare, unless a listed exception applies.
//
// Next.js middleware cannot see the socket. `installOriginLock` wraps
// `http.Server` and stamps the real peer into a per-process header before
// middleware runs. Forwarded headers are not a peer. They are read only after
// the socket address is a trusted proxy (Traefik / docker), and only the
// rightmost hop that proxy appended is the candidate.
//
// CF-Connecting-IP and X-Forwarded-For stay untouched while the flag is off.
// While it is on, those headers are removed unless this request was admitted
// because the peer is Cloudflare or the origin secret matched.

import {
  formatIp,
  ipMatchesAnyCidr,
  isCloudflareIp,
  isLoopbackIp,
  isValidCidr,
  parseForwardedToken,
  parseIp,
  type ParsedIp
} from "./cloudflare-ip-ranges";

export const ORIGIN_LOCK_HEADER = "x-origin-lock";
export const ORIGIN_PEER_STAMP_HEADER = "x-socratic-origin-peer";
export const ORIGIN_CLIENT_IP_TRUST_HEADER = "x-socratic-cf-client-trusted";

const STAMP_KEY = "__socraticOriginLockStamp";
const SECRET_MIN_LENGTH = 16;
const SECRET_MAX_LENGTH = 512;

/** Private ranges the Coolify proxy uses. Not an allow-all: the forwarded hop must still be Cloudflare. */
export const DEFAULT_TRUSTED_PROXY_CIDRS = [
  "127.0.0.0/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
  "fe80::/10"
] as const;

/** Tailscale CGNAT, so ops can reach the origin without going through Cloudflare. */
export const DEFAULT_ALLOW_CIDRS = ["100.64.0.0/10"] as const;

const CLIENT_IP_HEADERS = [
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-real-ip",
  "true-client-ip",
  "x-client-ip"
] as const;

export type OriginLockReason =
  | "disabled"
  | "health"
  | "secret"
  | "loopback"
  | "allowlist"
  | "cloudflare-peer"
  | "cloudflare-proxy"
  | "denied";

export interface OriginLockDecision {
  enabled: boolean;
  allow: boolean;
  /** When true, the hook may leave CF-Connecting-IP / X-Forwarded-For in place. */
  trustClientHeaders: boolean;
  reason: OriginLockReason;
}

export interface OriginLockInput {
  method: string;
  pathname: string;
  socketPeer: string | null;
  forwardedFor: string | null;
  /** Used only when X-Forwarded-For has no untrusted hop. A proxy that overwrites it may put its TCP peer here. */
  xRealIp: string | null;
  originLockHeader: string | null;
  env?: Record<string, string | undefined>;
}

interface StampState {
  token: string;
}

interface CidrLists {
  trustedKey: string;
  allowKey: string;
  trusted: string[];
  allow: string[];
}

export interface OriginLockNodeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null; destroy?: () => void };
}

export interface OriginLockNodeResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

interface HttpServerLike {
  Server: {
    prototype: {
      emit: (this: unknown, event: string, ...args: unknown[]) => boolean;
      __socraticOriginLock?: boolean;
    };
  };
}

type EmitFn = (this: unknown, event: string, ...args: unknown[]) => boolean;

let cidrLists: CidrLists | null = null;
let warnedWeakSecret = false;
let warnedBadCidr = false;
const denyLog = new Map<string, number>();
let patchedProto: HttpServerLike["Server"]["prototype"] | null = null;
let originalEmit: EmitFn | null = null;

function envOf(env?: Record<string, string | undefined>): Record<string, string | undefined> {
  return env ?? process.env;
}

export function originLockEnabled(env?: Record<string, string | undefined>): boolean {
  const raw = envOf(env).REQUIRE_CLOUDFLARE_ORIGIN;
  if (raw == null) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function listsFor(env: Record<string, string | undefined>): CidrLists {
  const trustedKey = env.ORIGIN_TRUSTED_PROXIES ?? "";
  const allowKey = env.ORIGIN_LOCK_ALLOW_CIDRS ?? "";
  if (cidrLists && cidrLists.trustedKey === trustedKey && cidrLists.allowKey === allowKey) return cidrLists;
  cidrLists = {
    trustedKey,
    allowKey,
    trusted: parseCidrEnv(env.ORIGIN_TRUSTED_PROXIES, DEFAULT_TRUSTED_PROXY_CIDRS),
    allow: parseCidrEnv(env.ORIGIN_LOCK_ALLOW_CIDRS, DEFAULT_ALLOW_CIDRS)
  };
  return cidrLists;
}

function parseCidrEnv(raw: string | undefined, fallback: readonly string[]): string[] {
  if (raw == null || raw.trim() === "") return [...fallback];
  if (raw.trim().toLowerCase() === "none") return [];
  const accepted: string[] = [];
  for (const part of raw.split(",")) {
    const cidr = part.trim();
    if (!cidr) continue;
    if (isValidCidr(cidr)) {
      accepted.push(cidr);
    } else if (!warnedBadCidr) {
      warnedBadCidr = true;
      console.warn("[origin-lock] ignoring an invalid CIDR in the origin-lock env");
    }
  }
  return accepted;
}

function originSecret(env: Record<string, string | undefined>): string | null {
  const raw = env.ORIGIN_LOCK_SECRET;
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length < SECRET_MIN_LENGTH) {
    if (!warnedWeakSecret) {
      warnedWeakSecret = true;
      console.warn("[origin-lock] ORIGIN_LOCK_SECRET is shorter than 16 characters, so the header check is off");
    }
    return null;
  }
  return trimmed;
}

function timingSafeEqualString(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    const a = i < left.length ? left.charCodeAt(i) : 0;
    const b = i < right.length ? right.charCodeAt(i) : 0;
    diff |= a ^ b;
  }
  return diff === 0;
}

function secretMatches(header: string | null, secret: string | null): boolean {
  if (!secret || header == null) return false;
  const presented = header.trim();
  if (!presented || presented.length > SECRET_MAX_LENGTH) return false;
  return timingSafeEqualString(presented, secret);
}

export function getStampState(): StampState | null {
  const value = (globalThis as Record<string, unknown>)[STAMP_KEY];
  if (!value || typeof value !== "object") return null;
  const token = (value as { token?: unknown }).token;
  if (typeof token !== "string" || token.length < 32) return null;
  return { token };
}

export function ensureStampToken(): string {
  const existing = getStampState();
  if (existing) return existing.token;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let token = "";
  for (const byte of bytes) token += byte.toString(16).padStart(2, "0");
  const state: StampState = { token };
  (globalThis as Record<string, unknown>)[STAMP_KEY] = state;
  return token;
}

export function setStampTokenForTests(token: string): void {
  (globalThis as Record<string, unknown>)[STAMP_KEY] = { token };
}

export function clearOriginLockForTests(): void {
  delete (globalThis as Record<string, unknown>)[STAMP_KEY];
  cidrLists = null;
  warnedWeakSecret = false;
  warnedBadCidr = false;
  denyLog.clear();
}

function headerJoined(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const value = headers[name];
  if (value == null) return null;
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : null;
  return value;
}

function requestPath(url: string | undefined): string {
  if (!url) return "/";
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      return new URL(url).pathname || "/";
    } catch {
      return "/";
    }
  }
  const query = url.indexOf("?");
  const path = query === -1 ? url : url.slice(0, query);
  return path.startsWith("/") ? path : "/";
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

function isHealthProbe(method: string, pathname: string): boolean {
  const verb = method.toUpperCase();
  if (verb !== "GET" && verb !== "HEAD") return false;
  return normalizePath(pathname) === "/api/live";
}

function forwardedPeers(forwardedFor: string | null): ParsedIp[] {
  if (!forwardedFor) return [];
  const peers: ParsedIp[] = [];
  for (const part of forwardedFor.split(",")) {
    const ip = parseForwardedToken(part);
    if (ip) peers.push(ip);
  }
  return peers;
}

/** Rightmost forwarded hop that is not itself a trusted proxy. */
export function upstreamPeer(forwardedFor: string | null, trusted: readonly string[]): ParsedIp | null {
  const peers = forwardedPeers(forwardedFor);
  for (let i = peers.length - 1; i >= 0; i--) {
    if (!ipMatchesAnyCidr(peers[i], trusted)) return peers[i];
  }
  return null;
}

export function evaluateOriginLock(input: OriginLockInput): OriginLockDecision {
  const env = envOf(input.env);
  if (!originLockEnabled(env)) {
    return { enabled: false, allow: true, trustClientHeaders: false, reason: "disabled" };
  }
  const lists = listsFor(env);
  const pathname = normalizePath(input.pathname);
  if (isHealthProbe(input.method, pathname)) {
    return { enabled: true, allow: true, trustClientHeaders: false, reason: "health" };
  }
  if (secretMatches(input.originLockHeader, originSecret(env))) {
    return { enabled: true, allow: true, trustClientHeaders: true, reason: "secret" };
  }
  const socket = parseIp(input.socketPeer);
  if (socket && isLoopbackIp(socket)) {
    return { enabled: true, allow: true, trustClientHeaders: false, reason: "loopback" };
  }
  if (socket && ipMatchesAnyCidr(socket, lists.allow)) {
    return { enabled: true, allow: true, trustClientHeaders: false, reason: "allowlist" };
  }
  if (socket && isCloudflareIp(socket)) {
    return { enabled: true, allow: true, trustClientHeaders: true, reason: "cloudflare-peer" };
  }
  if (socket && ipMatchesAnyCidr(socket, lists.trusted)) {
    // X-Forwarded-For's rightmost untrusted hop is the peer the proxy appended.
    // That hop wins over X-Real-IP so a client cannot hide an appended attacker
    // address behind a spoofed X-Real-IP. X-Real-IP is only the candidate when
    // the proxy did not supply a forwarded chain.
    const forwarded = upstreamPeer(input.forwardedFor, lists.trusted);
    const upstream = forwarded ?? (input.xRealIp ? parseIp(input.xRealIp) : null);
    if (upstream && isCloudflareIp(upstream)) {
      return { enabled: true, allow: true, trustClientHeaders: true, reason: "cloudflare-proxy" };
    }
  }
  return { enabled: true, allow: false, trustClientHeaders: false, reason: "denied" };
}

function noteDeny(peer: string | null, pathname: string): void {
  const key = `${peer ?? "-"} ${pathname}`;
  const now = Date.now();
  const previous = denyLog.get(key) ?? 0;
  if (now - previous < 60_000) return;
  if (denyLog.size > 200) denyLog.clear();
  denyLog.set(key, now);
  console.warn(`[origin-lock] rejected ${pathname} peer ${peer ?? "unknown"}`);
}

function denyResponse(res: OriginLockNodeResponse): void {
  res.statusCode = 403;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("connection", "close");
  res.end("Forbidden");
}

function stampAndMaybeStrip(req: OriginLockNodeRequest, decision: OriginLockDecision, socketPeer: string | null): void {
  const token = ensureStampToken();
  const parsed = parseIp(socketPeer);
  if (parsed) req.headers[ORIGIN_PEER_STAMP_HEADER] = `${token}|${formatIp(parsed)}`;
  else delete req.headers[ORIGIN_PEER_STAMP_HEADER];
  if (decision.trustClientHeaders) {
    req.headers[ORIGIN_CLIENT_IP_TRUST_HEADER] = `${token}|1`;
    return;
  }
  for (const name of CLIENT_IP_HEADERS) delete req.headers[name];
  delete req.headers[ORIGIN_CLIENT_IP_TRUST_HEADER];
}

export function applyOriginLockToNodeRequest(req: OriginLockNodeRequest, res: OriginLockNodeResponse): boolean {
  if (!originLockEnabled()) return true;
  const socketPeer = req.socket?.remoteAddress ?? null;
  const pathname = requestPath(req.url);
  const decision = evaluateOriginLock({
    method: req.method ?? "GET",
    pathname,
    socketPeer,
    forwardedFor: headerJoined(req.headers, "x-forwarded-for"),
    xRealIp: headerJoined(req.headers, "x-real-ip"),
    originLockHeader: headerJoined(req.headers, ORIGIN_LOCK_HEADER)
  });
  if (!decision.allow) {
    noteDeny(socketPeer, normalizePath(pathname));
    denyResponse(res);
    return false;
  }
  stampAndMaybeStrip(req, decision, socketPeer);
  return true;
}

export function applyOriginLockToUpgrade(
  req: OriginLockNodeRequest,
  socket: { end?: (chunk: string) => void; destroy?: () => void }
): boolean {
  if (!originLockEnabled()) return true;
  const socketPeer = req.socket?.remoteAddress ?? null;
  const pathname = requestPath(req.url);
  const decision = evaluateOriginLock({
    method: req.method ?? "GET",
    pathname,
    socketPeer,
    forwardedFor: headerJoined(req.headers, "x-forwarded-for"),
    xRealIp: headerJoined(req.headers, "x-real-ip"),
    originLockHeader: headerJoined(req.headers, ORIGIN_LOCK_HEADER)
  });
  if (!decision.allow) {
    noteDeny(socketPeer, normalizePath(pathname));
    try {
      socket.end?.("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 9\r\n\r\nForbidden");
    } catch {
      socket.destroy?.();
    }
    return false;
  }
  stampAndMaybeStrip(req, decision, socketPeer);
  return true;
}

export function readStampedPeer(stamp: string | null): { tokenKnown: boolean; peer: string | null } {
  const state = getStampState();
  if (!state) return { tokenKnown: false, peer: null };
  if (!stamp) return { tokenKnown: true, peer: null };
  const sep = stamp.indexOf("|");
  if (sep <= 0) return { tokenKnown: true, peer: null };
  const token = stamp.slice(0, sep);
  const ip = stamp.slice(sep + 1);
  if (!timingSafeEqualString(token, state.token)) return { tokenKnown: true, peer: null };
  const parsed = parseIp(ip);
  return { tokenKnown: true, peer: parsed ? formatIp(parsed) : null };
}

export function clientIpTrustMarkerMatches(header: string | null): boolean {
  const state = getStampState();
  if (!state || header == null) return false;
  return timingSafeEqualString(header.trim(), `${state.token}|1`);
}

export function middlewareOriginDecision(input: {
  method: string;
  pathname: string;
  stamp: string | null;
  forwardedFor: string | null;
  xRealIp: string | null;
  originLockHeader: string | null;
}): "defer" | "allow" | "deny" {
  if (!originLockEnabled()) return "defer";
  const stamped = readStampedPeer(input.stamp);
  if (!stamped.tokenKnown) return "defer";
  const decision = evaluateOriginLock({
    method: input.method,
    pathname: input.pathname,
    socketPeer: stamped.peer,
    forwardedFor: input.forwardedFor,
    xRealIp: input.xRealIp,
    originLockHeader: input.originLockHeader
  });
  return decision.allow ? "allow" : "deny";
}

export function installOriginLock(http: HttpServerLike): void {
  const proto = http.Server.prototype;
  if (proto.__socraticOriginLock) return;
  originalEmit = proto.emit;
  patchedProto = proto;
  proto.emit = function (this: unknown, event: string, ...args: unknown[]): boolean {
    if (event === "request" || event === "upgrade") {
      let admitted = true;
      try {
        if (event === "request") {
          const req = args[0] as OriginLockNodeRequest | undefined;
          const res = args[1] as OriginLockNodeResponse | undefined;
          if (req && res) admitted = applyOriginLockToNodeRequest(req, res);
        } else {
          const req = args[0] as OriginLockNodeRequest | undefined;
          const socket = args[1] as { end?: (chunk: string) => void; destroy?: () => void } | undefined;
          if (req && socket) admitted = applyOriginLockToUpgrade(req, socket);
        }
      } catch {
        if (originLockEnabled()) {
          console.error("[origin-lock] enforcement error; rejecting the request");
          if (event === "request") {
            const res = args[1] as OriginLockNodeResponse | undefined;
            try {
              if (res) denyResponse(res);
            } catch {
              // The response object was not usable. Drop the event anyway.
            }
          }
          return true;
        }
        admitted = true;
      }
      if (!admitted) return true;
    }
    return originalEmit!.apply(this, [event, ...args]);
  };
  proto.__socraticOriginLock = true;
}

export function uninstallOriginLockForTests(): void {
  if (patchedProto && originalEmit) {
    patchedProto.emit = originalEmit;
    delete patchedProto.__socraticOriginLock;
  }
  patchedProto = null;
  originalEmit = null;
}
