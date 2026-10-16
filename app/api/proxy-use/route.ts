/**
 * app/api/proxy-use/route.ts
 *
 * Public (no auth) watchdog endpoint: does recent trading/provider traffic go
 * through the residential proxy, and is the proxy reachable from this host?
 *
 * This route executes ON the Coolify host (inside the app container), so
 * `mango.reachable` genuinely tests the Coolify -> Mango leg, not the
 * watchdog's own network path.
 *
 * Exposes only aggregate proxy-use stats plus the proxy host:port — never
 * credentials, never request URLs or bodies.
 */

import "server-only";
import { Socket } from "node:net";
import { getProxyUseSnapshot } from "@/lib/proxy-use-log";
import { proxyProbePort, resolveResidentialProxyUrl, safeProxyHostForLog } from "@/lib/proxy-fetch";

export const dynamic = "force-dynamic";

const PROBE_TIMEOUT_MS = 3_000;
const PROBE_CACHE_MS = 60_000;

interface MangoProbe {
  /** The proxy host:port that was probed. */
  host: string;
  reachable: boolean;
  latencyMs: number | null;
  checkedAt: string;
}

let cachedProbe: MangoProbe | null = null;
let cachedAtMs = 0;

/** TCP-connect probe of the proxy's host:port. Resolves null on timeout/refusal. */
function probeTcpConnect(host: string, port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok ? Date.now() - startedAt : null);
    };
    const socket = new Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

async function checkProxyReachability(now: number): Promise<MangoProbe> {
  const checkedAt = new Date(now).toISOString();
  try {
    const proxyUrl = resolveResidentialProxyUrl() ?? "";
    const host = safeProxyHostForLog(proxyUrl);
    const url = new URL(proxyUrl);
    const port = proxyProbePort(url);
    const latencyMs = Number.isFinite(port)
      ? await probeTcpConnect(url.hostname, port, PROBE_TIMEOUT_MS)
      : null;
    return { host, reachable: latencyMs !== null, latencyMs, checkedAt };
  } catch {
    // Never throw: the watchdog needs reachable:false, not a 500.
    return { host: safeProxyHostForLog(""), reachable: false, latencyMs: null, checkedAt };
  }
}

export async function GET() {
  const now = Date.now();
  try {
    let mango = cachedProbe;
    if (!mango || now - cachedAtMs >= PROBE_CACHE_MS) {
      // Cache for 60s so the 2-minute watchdog cadence never hammers the probe.
      mango = await checkProxyReachability(now);
      cachedProbe = mango;
      cachedAtMs = now;
    }
    return Response.json({ ok: true, snapshot: getProxyUseSnapshot(now), mango });
  } catch {
    // Never throw: a broken snapshot/probe path must still answer reachable:false.
    return Response.json({
      ok: true,
      snapshot: { latest: null, lastHour: { proxied: 0, direct: 0, fallbacks: 0, proxyErrors: 0 }, total: 0 },
      mango: { host: safeProxyHostForLog(""), reachable: false, latencyMs: null, checkedAt: new Date(now).toISOString() }
    });
  }
}
