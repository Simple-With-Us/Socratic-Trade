/**
 * app/api/proxy-use/route.ts
 *
 * Public (no auth) watchdog endpoint: does recent trading/provider traffic go
 * through the residential proxy, and is the proxy reachable from this host?
 *
 * This route executes ON the Coolify host (inside the app container), so
 * `mango.reachable` genuinely tests the Coolify -> Mango leg, not the
 * watchdog's own network path.  The probe itself lives in
 * src/lib/mango-probe.ts (multi-attempt connect, success/failure cache TTLs,
 * and a failureKind that separates refused from timeout from error).
 *
 * Exposes aggregate proxy-use stats, the proxy host:port, and the live
 * concurrency gate (inFlight, queued, oldestHoldMs).  Never credentials,
 * never request URLs or bodies.
 */

import "server-only";
import { getMangoProbe, type MangoProbe } from "@/lib/mango-probe";
import { getProxyUseSnapshot } from "@/lib/proxy-use-log";
import { proxyGateSnapshot, safeProxyHostForLog } from "@/lib/proxy-fetch";
import { recordProxyGateSnapshot } from "@/lib/sentry-metrics";

export const dynamic = "force-dynamic";

export async function GET() {
  const now = Date.now();
  const gate = proxyGateSnapshot();
  recordProxyGateSnapshot(gate);
  try {
    const mango = await getMangoProbe(now);
    return Response.json({ ok: true, snapshot: getProxyUseSnapshot(now), mango, gate });
  } catch {
    // Never throw: a broken snapshot/probe path must still answer reachable:false.
    const mango: MangoProbe = {
      host: safeProxyHostForLog(""),
      reachable: false,
      latencyMs: null,
      checkedAt: new Date(now).toISOString(),
      attempts: 0,
      failureKind: "error"
    };
    return Response.json({
      ok: true,
      snapshot: { latest: null, lastHour: { proxied: 0, direct: 0, fallbacks: 0, proxyErrors: 0 }, total: 0 },
      mango,
      gate
    });
  }
}
