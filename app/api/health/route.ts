import { getInternalSetting, getServiceHealthSummaries, databasePath, resolveApiKeyWithSource, alertStorageWarning } from "@/lib/db";
import { HEALTH_REASON_CONSECUTIVE_FAILURES } from "@/lib/db-health";
import { getProviderTierStatus } from "@/lib/provider-tier";
import { getLease } from "@/lib/scheduler-lease";
import { statSync, statfsSync, readdirSync } from "fs";
import { dirname, join } from "path";

export const dynamic = "force-dynamic";

// Litestream replication freshness. Prod runs `litestream replicate` to R2 (see docs/litestream.md),
// so there is NO local `<dbPath>-litestream` sidecar dir — the age must be read from a state source
// that the litestream launcher actually writes. LITESTREAM_STATE_PATH points at that source (a dir or
// a file whose mtime advances on each successful sync). It falls back to the legacy `<dbPath>-litestream`
// sidecar only when the env is unset (0.4.x-style local replicas / dev).
//
// Returns:
//   { ageSeconds: number }  — freshness known (state source found).
//   { unknown: true }       — state source unreadable/absent: freshness is NOT confirmed healthy.
// The old behavior (silent null) let a stale R2 replica read as healthy; "unknown" is honest instead.
function getLitestreamFreshness(dbPath: string): { ageSeconds: number } | { unknown: true } {
  const statePath = process.env.LITESTREAM_STATE_PATH?.trim() || `${dbPath}-litestream`;
  try {
    let newestMs = 0;
    const scan = (target: string) => {
      const stat = statSync(target);
      if (stat.isDirectory()) {
        for (const file of readdirSync(target)) scan(join(target, file));
      } else if (stat.mtimeMs > newestMs) {
        newestMs = stat.mtimeMs;
      }
    };
    scan(statePath);
    if (newestMs === 0) return { unknown: true };
    return { ageSeconds: Math.round((Date.now() - newestMs) / 1000) };
  } catch {
    return { unknown: true };
  }
}

// Real liveness probe (was an unconditional {ok:true}). A health check that can never fail is
// worse than none for a system that can hold real positions — it hides outages. This probes:
//   - DB reachability (the getInternalSetting read throws if SQLite is unwritable/locked), and
//   - scheduler liveness (age of the last tick heartbeat; stale ⇒ autonomy/stops aren't running).
// Returns 503 when a critical check fails so PM2/uptime tooling can act.
export function GET() {
  const checks: Record<string, unknown> = {};
  let ok = true;

  let lastTick: string | undefined;
  try {
    lastTick = getInternalSetting<string>("scheduler:lastTick"); // also proves the DB is reachable
    checks.db = "ok";
  } catch (error) {
    ok = false;
    checks.db = error instanceof Error ? error.message : "error";
  }

  if (lastTick) {
    const ageMs = Date.now() - new Date(lastTick).getTime();
    checks.schedulerLastTick = lastTick;
    checks.schedulerAgeSeconds = Math.round(ageMs / 1000);
    // The scheduler ticks every 60s; >5 min of silence is degraded (not a hard failure here —
    // the process may legitimately be a non-scheduler instance).
    if (ageMs > 5 * 60_000) checks.schedulerStale = true;
  } else {
    checks.schedulerLastTick = null;
  }

  // Scheduler lease state (additive; only meaningful when SCHEDULER_SINGLE_LEADER is on).
  // Surfaced here so ops tooling can confirm which process is the current leader and how old
  // the lease is. Never breaks the liveness probe.
  try {
    const lease = getLease();
    if (lease) {
      checks.schedulerLease = {
        owner: lease.owner,
        acquiredAt: lease.acquiredAt,
        expiresAt: lease.expiresAt,
        ageSeconds: Math.round(lease.ageMs / 1000),
        expired: lease.expired
      };
    } else {
      checks.schedulerLease = null;
    }
  } catch {
    // never let lease reporting break the liveness probe
  }

  // Market-data paid-tier watchdog status (per the nightly provider-tier check). Surfaced here so the
  // status/admin/health tool can show whether the Massive/FMP subscriptions are live; a key detected
  // as "free" (lapsed sub) marks the section degraded but does NOT fail the liveness probe.
  try {
    const tiers = getProviderTierStatus();
    if (Object.keys(tiers).length > 0) {
      checks.dataProviders = tiers;
      if (Object.values(tiers).some((t) => t?.tier === "free")) checks.dataProvidersDegraded = true;
    }
  } catch {
    // never let provider-tier reporting break the health probe
  }

  // Surface Pinecone and Voyage configuration status
  try {
    const pineconeKey = resolveApiKeyWithSource("pinecone");
    const voyageKey = resolveApiKeyWithSource("voyage");
    checks.pineconeConfigured = pineconeKey.source !== "none";
    checks.voyageConfigured = voyageKey.source !== "none";

    // If global keys are missing for critical dependencies, mark degraded
    if (pineconeKey.source === "none" || voyageKey.source === "none") {
      checks.ragConfigured = false;
    }
  } catch {
    // do not break health check on key resolution
  }

  // Surface every backend dependency from health summaries.
  //
  // PUBLIC route (no requireAdmin): expose ONLY boolean/degraded status — never the raw
  // `lastFailureError` provider string (that detailed payload stays on the admin
  // connections-health route). A `degraded` flag captures the soft/cold-start case without
  // failing liveness; the detailed reason text is deliberately omitted here.
  try {
    const summaries = getServiceHealthSummaries();
    const dependencies: Record<string, { ok: boolean; degraded?: boolean }> = {};
    // Collapse (service, keySource) lanes to one entry per service. Prefer a CONFIGURED lane
    // (env/user) over a stale keySource:"none" lane so a service that later got a working key isn't
    // pinned failed forever by an old missing-key "none" lane (no future success is logged to "none").
    const configuredService = new Set<string>();
    for (const summary of summaries) {
      if (summary.keySource === "env" || summary.keySource === "user") configuredService.add(summary.service);
    }
    for (const summary of summaries) {
      const isGlobal = summary.keySource === "env" || summary.keySource === "none" || summary.keySource === null;
      if (!isGlobal) continue;
      // Ignore a stale "none"/null lane once the service has a real configured lane — otherwise it
      // would overwrite the healthy env lane and pin the service failed indefinitely.
      const isNoneLane = summary.keySource === "none" || summary.keySource === null;
      if (isNoneLane && configuredService.has(summary.service)) continue;

      // Only the HARD reason (>=5 consecutive failures) fails liveness. The SOFT heuristics
      // ("active this hour but no success yet") that a single cold-start 500 can trip mark the
      // service degraded but must NOT 503.
      const hardStopped = summary.stoppedWorking && summary.stoppedReason === HEALTH_REASON_CONSECUTIVE_FAILURES;
      const existing = dependencies[summary.service];
      const nextOk = !hardStopped;
      const nextDegraded = summary.stoppedWorking && !hardStopped;
      if (existing) {
        // Merge lanes for the same service: any hard-stopped lane wins ok=false; degraded is sticky.
        dependencies[summary.service] = {
          ok: existing.ok && nextOk,
          degraded: existing.degraded || nextDegraded || undefined
        };
      } else {
        dependencies[summary.service] = { ok: nextOk, degraded: nextDegraded || undefined };
      }

      // Hard-liveness deps: only app-unsafe/unusable dependencies 503 the public probe. Paid
      // market-data lanes (fmp/massive) degrade to Yahoo/others (the provider-tier section already
      // reports data-provider degradation), so they mark degraded but never fail liveness.
      const isCritical = ["pinecone", "voyage", "voyage-rerank", "alpaca-broker"].includes(summary.service);
      if (isCritical && hardStopped) {
        ok = false;
      }
    }
    checks.dependencies = dependencies;
  } catch {
    // never let connection health summaries break the health probe
  }

  // Disk and database headroom check (purely advisory, never fails the health probe)
  try {
    const dbPath = databasePath();
    const walPath = `${dbPath}-wal`;
    const dbDir = dirname(dbPath);

    let dbSizeBytes = 0;
    try {
      dbSizeBytes = statSync(dbPath).size;
    } catch {}

    let walSizeBytes = 0;
    try {
      walSizeBytes = statSync(walPath).size;
    } catch {}

    let freeBytes = 0;
    let totalBytes = 0;
    try {
      const stats = statfsSync(dbDir);
      freeBytes = stats.bavail * stats.bsize;
      totalBytes = stats.blocks * stats.bsize;
    } catch {}

    const freshness = getLitestreamFreshness(dbPath);
    const litestreamAgeSeconds = "ageSeconds" in freshness ? freshness.ageSeconds : null;
    // "unknown" means the state source couldn't be read — freshness is NOT confirmed healthy
    // (distinct from a real, fresh age). Surface it honestly rather than as a healthy null.
    const litestreamState: "known" | "unknown" = "ageSeconds" in freshness ? "known" : "unknown";

    checks.storage = {
      dbSizeBytes,
      walSizeBytes,
      freeBytes,
      totalBytes,
      litestreamAgeSeconds,
      litestreamState
    };

    // Thresholds:
    // Disk free space < 1 GB or WAL size > 500 MB or Litestream last-sync age > 1 hour (3600s)
    const diskLow = freeBytes > 0 && freeBytes < 1024 * 1024 * 1024;
    const walLarge = walSizeBytes > 500 * 1024 * 1024;
    const litestreamStale = litestreamAgeSeconds !== null && litestreamAgeSeconds > 3600;
    // Only alert on unknown freshness when a state path was explicitly configured — an operator who
    // pointed us at the real source expects it to be readable, so an unreadable one is a real signal.
    // Without LITESTREAM_STATE_PATH set, "unknown" is the expected default (R2 replicas leave no local
    // state file) and must not spam alerts.
    const litestreamUnknownConfigured = litestreamState === "unknown" && !!process.env.LITESTREAM_STATE_PATH?.trim();

    if (diskLow || walLarge || litestreamStale || litestreamUnknownConfigured) {
      checks.storageDegraded = true;

      // Send a one-shot needs-attention notification/alert via the notifier if not sent recently
      if (diskLow) void alertStorageWarning("disk_space_low", `Free disk space is low: ${(freeBytes / 1024 / 1024).toFixed(2)} MB remaining.`);
      if (walLarge) void alertStorageWarning("wal_size_large", `SQLite WAL file size is large: ${(walSizeBytes / 1024 / 1024).toFixed(2)} MB.`);
      if (litestreamStale) void alertStorageWarning("litestream_replication_stale", `Litestream WAL replication has not synced in ${Math.round(litestreamAgeSeconds! / 60)} minutes.`);
      if (litestreamUnknownConfigured) void alertStorageWarning("litestream_state_unreadable", `Litestream state source at ${process.env.LITESTREAM_STATE_PATH?.trim()} is unreadable — replication freshness cannot be confirmed.`);
    }
  } catch {
    // never let storage monitoring break the health probe
  }

  return Response.json({ ok, checks }, { status: ok ? 200 : 503 });
}
