/**
 * src/lib/proxy-use-log.ts
 *
 * Per-request log of residential-proxy use for market-data/provider traffic.
 * An in-memory ring buffer (last 100 entries) fed by dataSourceFetch
 * (src/lib/data-source-fetch.ts) at every exit path, and read by the public
 * GET /api/proxy-use endpoint so an external watchdog can tell whether recent
 * trading/provider traffic actually went through the proxy, what each proxied
 * request's destination and outcome was, and whether the Mango is reachable
 * from the Coolify host.
 *
 * Each request routed through the proxy gets exactly ONE entry, recorded once
 * its outcome is known: timestamp, destination host, and outcome (HTTP status
 * code, or a short error class when the request threw). Low-volume by design:
 * one entry per proxied request — never request/response bodies, never
 * credentials, never tokens or PII.
 *
 * Dependency-free and server-only. Entries carry the proxy host:port and the
 * destination hostname only — never credentials, never full request URLs
 * (query strings can carry tokens), never bodies.
 *
 * The ring is pinned on globalThis. Next.js can bundle dataSourceFetch and
 * GET /api/proxy-use as separate module instances in one process; a module
 * local array would let the endpoint read an empty buffer.
 */

import "server-only";

export type ProxyUseSource = "user" | "env" | "default" | "none";

export interface ProxyUseEntry {
  /** Epoch ms when the entry was recorded (for proxied requests: once the outcome is known). */
  ts: number;
  /** True when the request was sent through the proxy. */
  usedProxy: boolean;
  /** Where the proxy URL came from ("none" when no proxy was used). */
  source: ProxyUseSource;
  /** Proxy host:port (userinfo stripped), or null when unused/unparseable. */
  host: string | null;
  /** True when this entry is a fail_soft fallback to direct egress. */
  fallback: boolean;
  /** Data-source service name the call site passed, if any. */
  service?: string;
  /**
   * Destination hostname of the data-source request. Never the full URL —
   * query strings can carry credentials or tokens. Set on entries for
   * requests routed through the proxy and on fail_soft fallback entries.
   */
  destination?: string;
  /** HTTP status of the proxied response, when a response was received. */
  statusCode?: number;
  /**
   * Short error class for a proxied request that threw: the error's `code`
   * (ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT, ...) or, failing that, its
   * `name` (AbortError, ...). Never the error message.
   */
  errorClass?: string;
  /** Caller signal ended the request; not a proxy failure. */
  cancelled?: boolean;
}

export interface ProxyUseSnapshot {
  latest: ProxyUseEntry | null;
  lastHour: { proxied: number; direct: number; fallbacks: number; proxyErrors: number };
  total: number;
}

const RING_CAPACITY = 100;
const HOUR_MS = 3_600_000;

type ProxyUseRingHost = typeof globalThis & {
  __socraticProxyUseRing?: ProxyUseEntry[];
};

const ringHost = globalThis as ProxyUseRingHost;
const ring: ProxyUseEntry[] = (ringHost.__socraticProxyUseRing ??= []);

/** Record one proxy-use decision. Never throws (logging must not break a fetch). */
export function recordProxyUse(entry: Omit<ProxyUseEntry, "ts"> & { ts?: number }): void {
  try {
    ring.push({ ts: Date.now(), ...entry });
    if (ring.length > RING_CAPACITY) {
      ring.splice(0, ring.length - RING_CAPACITY);
    }
  } catch {
    // logging is additive telemetry; never let it break a data-source call
  }
}

/** Aggregate snapshot for the watchdog: latest entry + last-hour counts. */
export function getProxyUseSnapshot(now: number = Date.now()): ProxyUseSnapshot {
  const cutoff = now - HOUR_MS;
  let proxied = 0;
  let direct = 0;
  let fallbacks = 0;
  let proxyErrors = 0;
  for (const entry of ring) {
    if (entry.ts < cutoff) continue;
    if (entry.usedProxy) {
      proxied += 1;
      if (entry.errorClass && !entry.cancelled) proxyErrors += 1;
    } else {
      direct += 1;
    }
    if (entry.fallback) fallbacks += 1;
  }
  return {
    latest: ring.length > 0 ? ring[ring.length - 1] : null,
    lastHour: { proxied, direct, fallbacks, proxyErrors },
    total: ring.length
  };
}

/** Test hook: empty the ring buffer so tests are isolated. */
export function __resetProxyUseLogForTests(): void {
  ring.length = 0;
}
