import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import {
  getR2UsageSnapshots,
  isR2AutoDisableArmed,
  isR2ReplicationDisabled,
  loadR2UsageAccounts,
  loadR2UsageMonitorConfig,
} from "@/lib/r2-usage";

export const dynamic = "force-dynamic";

/** Latest per-account R2 free-tier snapshots written by the scheduler lane —
 *  reads the persisted KV only, never calls Cloudflare on page load. The fleet
 *  uses three Cloudflare accounts (st/ct/um), each with its own free tier. */
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const cfg = loadR2UsageMonitorConfig();
  const accounts = loadR2UsageAccounts();
  const snapshots = getR2UsageSnapshots();
  return NextResponse.json({
    configured: accounts.length > 0,
    accountsConfigured: accounts.map((a) => ({ id: a.id, label: a.label })),
    intervalHours: cfg.intervalHours,
    thresholdPct: cfg.thresholdPct,
    bucketFilter: cfg.bucketFilter,
    replicationDisabled: isR2ReplicationDisabled(cfg),
    autoDisableArmed: isR2AutoDisableArmed(cfg),
    snapshots,
  });
}
