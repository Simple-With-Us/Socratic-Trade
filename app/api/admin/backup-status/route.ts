import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { databasePath } from "@/lib/db";
import {
  assessLitestreamRuntimeHealth,
  assessLitestreamTierFreshness,
  defaultLitestreamStatePath,
  getLitestreamRuntimeHealth,
  runtimeReleaseIdentity,
  type LitestreamRemoteInventoryState,
  type LitestreamTierFreshness
} from "@/lib/runtime-health";
import { getLitestreamRemoteInventory } from "@/lib/litestream-remote-inventory";

export const dynamic = "force-dynamic";

export interface BackupStatusPayload {
  liveMode: boolean;
  statePath: string;
  overall: {
    state: "known" | "unknown";
    status: string | null;
    lastSyncAt: string | null;
    ageSeconds: number | null;
    source: "ipc" | "file" | "none";
    degraded: boolean;
    reasons: string[];
  };
  tiers: LitestreamTierFreshness[];
  tiersDegraded: boolean;
  coverage: {
    observed: number;
    notObservable: number;
    total: number;
    remoteInventoryState: LitestreamRemoteInventoryState;
    remoteInventoryCollectedAt: string | null;
  };
  asOf: string;
}

/**
 * Admin-only view backing app/admin/backups/ — the same signals /api/health surfaces publicly
 * (checks.storage.litestream* + checks.storage.litestreamTiers), reshaped so the UI does not have
 * to reverse-engineer the public health-probe response. Read-only: no writes, no S3/B2 calls, no
 * SSH — same local IPC socket read + local file mtime scan the public probe already performs.
 */
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const release = runtimeReleaseIdentity();
  const dbPath = databasePath();
  const liveMode = process.env.DB_BOOTSTRAP === "live";
  const statePath = process.env.LITESTREAM_STATE_PATH?.trim() || defaultLitestreamStatePath(dbPath);

  const freshness = await getLitestreamRuntimeHealth({
    dbPath,
    statePath,
    allowFileFallback: !liveMode
  });
  const assessment = assessLitestreamRuntimeHealth(freshness, {
    liveMode,
    processUptimeSeconds: release.processUptimeSeconds
  });
  // Level 0 from the local LTX cache; levels 1/2/3/9 from the scheduler's periodic replica
  // inventory. This request itself performs no S3/B2 call and spawns no process.
  const tierFreshness = assessLitestreamTierFreshness(statePath, {
    remoteInventory: getLitestreamRemoteInventory()
  });

  const payload: BackupStatusPayload = {
    liveMode,
    statePath,
    overall: {
      state: freshness.state,
      status: freshness.state === "known" ? freshness.status : null,
      lastSyncAt: freshness.state === "known" ? freshness.lastSyncAt : null,
      ageSeconds: freshness.state === "known" ? freshness.ageSeconds : null,
      source: freshness.source,
      degraded: assessment.degraded,
      reasons: assessment.reasons
    },
    tiers: tierFreshness.tiers,
    tiersDegraded: tierFreshness.degraded,
    coverage: {
      observed: tierFreshness.observedTiers,
      notObservable: tierFreshness.notObservableTiers,
      total: tierFreshness.tiers.length,
      remoteInventoryState: tierFreshness.remoteInventoryState,
      remoteInventoryCollectedAt: tierFreshness.remoteInventoryCollectedAt
    },
    asOf: new Date().toISOString()
  };

  return NextResponse.json(payload, {
    status: 200,
    headers: { "Cache-Control": "private, no-store" }
  });
}
