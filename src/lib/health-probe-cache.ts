import { getInternalSetting, getServiceHealthSummaries } from "@/lib/db";
import { getOpenRouterCreditStatus } from "@/lib/openrouter-credits";
import { yieldEventLoop } from "@/lib/slow-sync-guard";
import { getTradingLivenessSummary } from "@/lib/trading-liveness";

/**
 * Call sites the public probe must be able to skip.  Tests replace these
 * with a blocking stand-in and assert a warm GET does not invoke them.
 * Lives outside the route module: Next.js rejects extra exports on
 * app/api/health/route.ts.
 */
export const healthProbeDeps = {
  getInternalSetting,
  getServiceHealthSummaries,
  getTradingLivenessSummary,
  getOpenRouterCreditStatus
};

export type HealthPayload = { ok: boolean; checks: Record<string, unknown> };

/** Warm probes serve this.  Refresh replaces the object; it does not mutate it. */
let healthSnapshot: { at: number; payload: HealthPayload } | null = null;
let healthRefreshInFlight = false;

export function __resetHealthSnapshotForTests(): void {
  healthSnapshot = null;
  healthRefreshInFlight = false;
}

/**
 * Production keeps a short memory snapshot so Sentry's ~8s uptime GET does not
 * wait on SQLite or OpenRouter.  Vitest defaults to 0 (always assemble) unless
 * a test sets HEALTH_SNAPSHOT_TTL_MS.
 */
export function healthSnapshotTtlMs(): number {
  const raw = process.env.HEALTH_SNAPSHOT_TTL_MS;
  if (raw != null && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return process.env.VITEST ? 0 : 2_000;
}

export function scheduleHealthRefresh(assemble: () => Promise<HealthPayload>): void {
  if (healthRefreshInFlight) return;
  healthRefreshInFlight = true;
  void (async () => {
    // Let the probe that noticed the stale snapshot finish before any sync read.
    await yieldEventLoop();
    try {
      const payload = await assemble();
      healthSnapshot = { at: Date.now(), payload };
    } catch {
      // Keep the last good snapshot.  A failed refresh must not 503 the next probe.
    } finally {
      healthRefreshInFlight = false;
    }
  })();
}

/**
 * Return the cached payload when the TTL is positive and a snapshot exists.
 * A stale snapshot still returns immediately and schedules a refresh.
 */
export function readWarmHealthSnapshot(
  assemble: () => Promise<HealthPayload>,
  now = Date.now()
): HealthPayload | null {
  const ttl = healthSnapshotTtlMs();
  if (!(ttl > 0 && healthSnapshot)) return null;
  if (!healthRefreshInFlight && now - healthSnapshot.at >= ttl) scheduleHealthRefresh(assemble);
  return healthSnapshot.payload;
}

export function storeHealthSnapshot(payload: HealthPayload, at = Date.now()): void {
  healthSnapshot = { at, payload };
}
