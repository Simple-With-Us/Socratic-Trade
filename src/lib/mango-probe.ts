/**
 * src/lib/mango-probe.ts
 *
 * Reachability probe behind the `mango` field of GET /api/proxy-use: can this
 * host open a TCP connection to the residential proxy (the Mango) right now?
 * Lives outside the route module because Next.js rejects extra exports on
 * app/api route modules, and tests need to replace the connect call with a
 * scripted stand-in (same pattern as health-probe-cache.ts).
 *
 * Why the check looks like this — the Nov 13–14, 2026 false-alert flap:
 * the old probe made ONE connect attempt with a 3s timeout and cached the
 * verdict for 60s either way.  Worse, that "timeout" was Socket.setTimeout,
 * which does not bound the connect phase at all: on Nov 14, 2026 the probe
 * recorded a connect completing at 29,260 ms while the proxy was healthy,
 * and the watchdog read behind it timed out entirely.  Live samples of
 * that probe's own latencyMs while healthy ran 140–2,008 ms (Nov 14,
 * 19:49–19:54 UTC): a WireGuard path to a home router routinely spends a
 * full TCP SYN retransmit step (~1s, then ~2–3s) on a single connect, so
 * one slow but healthy connect could cross any small bound.  The watchdog confirms a failure by
 * re-reading the endpoint ~10s later, and the 60s failure cache served the
 * same failed sample to both reads — one bad sample became a "missed
 * twice" confirmed outage, 16+ times in a day, while real proxied traffic
 * kept flowing (65 proxied vs 2 proxy errors in the same last-hour window).
 *
 * The fix keeps the verdict honest without going soft on real outages:
 *   - A check is up to MANGO_PROBE_MAX_ATTEMPTS connects.  Any success
 *     makes the check reachable.  A refused port answers instantly, so a
 *     genuinely dead proxy still fails every attempt in about a second;
 *     only the timeout path (dropped SYNs on a live path) spends longer.
 *   - Successes are cached 60s (the 2-minute watchdog cadence never
 *     hammers the probe).  Failures are cached only 5s, so the watchdog's
 *     10s-later confirmation read runs a genuinely fresh check instead of
 *     re-reading the failed sample.
 *   - `failureKind` separates a refused connection (host answered, port
 *     closed — the real-outage signature) from a timeout (path loss or
 *     latency) and from an internal error (unresolvable proxy config), so
 *     consumers stop conflating "could not assess cleanly" with "down".
 */

import "server-only";
import { Socket } from "node:net";
import { proxyProbePort, resolveResidentialProxyUrl, safeProxyHostForLog } from "@/lib/proxy-fetch";

/** Why a connect attempt failed: the SYN was never answered, the host refused, or something else went wrong. */
export type MangoProbeFailureKind = "timeout" | "refused" | "error";

export interface MangoProbe {
  /** The proxy host:port that was probed. */
  host: string;
  reachable: boolean;
  /** Latency of the successful connect; null when unreachable. */
  latencyMs: number | null;
  checkedAt: string;
  /** Connect attempts the deciding check used (0 when the check itself errored before any attempt). */
  attempts: number;
  /** Why the deciding check's last attempt failed; null when reachable. */
  failureKind: MangoProbeFailureKind | null;
}

export type MangoConnectOutcome =
  | { ok: true; latencyMs: number }
  | { ok: false; failureKind: MangoProbeFailureKind };

/** Per-attempt TCP connect timeout.  Healthy connects on this path measure up to ~2s (see header). */
export const MANGO_PROBE_ATTEMPT_TIMEOUT_MS = 3_000;
/** Attempts per check before the check reports unreachable. */
export const MANGO_PROBE_MAX_ATTEMPTS = 3;
/** Pause between attempts inside one check. */
export const MANGO_PROBE_RETRY_DELAY_MS = 250;
/** How long a successful verdict is served from cache. */
export const MANGO_PROBE_SUCCESS_CACHE_MS = 60_000;
/** How long a failed verdict is served from cache — short, so a 10s-later re-read re-probes. */
export const MANGO_PROBE_FAILURE_CACHE_MS = 5_000;

/** TCP-connect probe of the proxy's host:port.  Resolves an outcome; never rejects. */
function probeTcpConnect(host: string, port: number, timeoutMs: number): Promise<MangoConnectOutcome> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    // Socket.setTimeout alone does NOT bound the connect phase: on
    // 2026-11-14 the old probe recorded a connect completing at 29,260 ms
    // under a 3,000 ms socket timeout (the inactivity timer only runs once
    // the socket is connected).  Enforce the bound with a wall-clock
    // deadline so a hung SYN can never stall the endpoint or the watchdog.
    const deadline = setTimeout(() => done({ ok: false, failureKind: "timeout" }), timeoutMs);
    const done = (outcome: MangoConnectOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(outcome);
    };
    const socket = new Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done({ ok: true, latencyMs: Date.now() - startedAt }));
    socket.once("timeout", () => done({ ok: false, failureKind: "timeout" }));
    socket.once("error", (err: Error) =>
      done({
        ok: false,
        failureKind: (err as NodeJS.ErrnoException)?.code === "ECONNREFUSED" ? "refused" : "error"
      })
    );
    socket.connect(port, host);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call sites a test needs to replace: the raw connect and the retry pause.
 * Tests assign scripted stand-ins and restore the originals afterwards.
 */
export const mangoProbeDeps: {
  connectTcp: typeof probeTcpConnect;
  sleep: typeof sleep;
} = {
  connectTcp: probeTcpConnect,
  sleep
};

/** One full check: resolve the proxy target, then connect until an attempt lands or attempts run out. */
async function runMangoProbe(now: number): Promise<MangoProbe> {
  const checkedAt = new Date(now).toISOString();
  let host = safeProxyHostForLog("");
  try {
    const proxyUrl = resolveResidentialProxyUrl() ?? "";
    host = safeProxyHostForLog(proxyUrl);
    const url = new URL(proxyUrl);
    const port = proxyProbePort(url);
    if (!Number.isFinite(port)) {
      return { host, reachable: false, latencyMs: null, checkedAt, attempts: 0, failureKind: "error" };
    }
    let lastFailure: MangoProbeFailureKind = "error";
    for (let attempt = 1; attempt <= MANGO_PROBE_MAX_ATTEMPTS; attempt += 1) {
      const outcome = await mangoProbeDeps.connectTcp(url.hostname, port, MANGO_PROBE_ATTEMPT_TIMEOUT_MS);
      if (outcome.ok) {
        return { host, reachable: true, latencyMs: outcome.latencyMs, checkedAt, attempts: attempt, failureKind: null };
      }
      lastFailure = outcome.failureKind;
      if (attempt < MANGO_PROBE_MAX_ATTEMPTS) {
        await mangoProbeDeps.sleep(MANGO_PROBE_RETRY_DELAY_MS);
      }
    }
    return {
      host,
      reachable: false,
      latencyMs: null,
      checkedAt,
      attempts: MANGO_PROBE_MAX_ATTEMPTS,
      failureKind: lastFailure
    };
  } catch {
    // Never throw: the watchdog needs reachable:false, not a 500.
    return { host, reachable: false, latencyMs: null, checkedAt, attempts: 0, failureKind: "error" };
  }
}

let cachedProbe: MangoProbe | null = null;
let cachedAtMs = 0;

/** Test hook: drop the cached verdict so tests are isolated. */
export function __resetMangoProbeForTests(): void {
  cachedProbe = null;
  cachedAtMs = 0;
}

/**
 * The probe verdict for the route, cached per the asymmetric TTLs above:
 * successes for MANGO_PROBE_SUCCESS_CACHE_MS, failures only
 * MANGO_PROBE_FAILURE_CACHE_MS.
 */
export async function getMangoProbe(now: number = Date.now()): Promise<MangoProbe> {
  if (cachedProbe) {
    const ttlMs = cachedProbe.reachable ? MANGO_PROBE_SUCCESS_CACHE_MS : MANGO_PROBE_FAILURE_CACHE_MS;
    if (now - cachedAtMs < ttlMs) return cachedProbe;
  }
  const probe = await runMangoProbe(now);
  cachedProbe = probe;
  cachedAtMs = now;
  return probe;
}
