/**
 * src/lib/proxy-use-log.ts
 *
 * Per-request log of residential-proxy use decisions for market-data/provider
 * traffic. An in-memory ring buffer (last 100 entries) fed by dataSourceFetch
 * (src/lib/data-source-fetch.ts) at every exit path, and read by the public
 * GET /api/proxy-use endpoint so an external watchdog can tell whether recent
 * trading/provider traffic actually went through the proxy and whether the
 * Mango is reachable from the Coolify host.
 *
 * Dependency-free and server-only. Entries carry host:port of the proxy only —
 * never credentials, never request URLs or bodies.
 */

import "server-only";

export type ProxyUseSource = "user" | "env" | "default" | "none";

export interface ProxyUseEntry {
  /** Epoch ms when the decision was recorded. */
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
}

export interface ProxyUseSnapshot {
  latest: ProxyUseEntry | null;
  lastHour: { proxied: number; direct: number; fallbacks: number };
  total: number;
}

const RING_CAPACITY = 100;
const HOUR_MS = 3_600_000;

const ring: ProxyUseEntry[] = [];

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

/** Aggregate snapshot for the watchdog: latest decision + last-hour counts. */
export function getProxyUseSnapshot(now: number = Date.now()): ProxyUseSnapshot {
  const cutoff = now - HOUR_MS;
  let proxied = 0;
  let direct = 0;
  let fallbacks = 0;
  for (const entry of ring) {
    if (entry.ts < cutoff) continue;
    if (entry.usedProxy) proxied += 1;
    else direct += 1;
    if (entry.fallback) fallbacks += 1;
  }
  return {
    latest: ring.length > 0 ? ring[ring.length - 1] : null,
    lastHour: { proxied, direct, fallbacks },
    total: ring.length
  };
}

/** Test hook: empty the ring buffer so tests are isolated. */
export function __resetProxyUseLogForTests(): void {
  ring.length = 0;
}
