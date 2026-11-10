import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import {
  isR2AutoDisableArmed,
  isR2ReplicationDisabled,
  loadR2UsageMonitorConfig,
  resumeR2Replication,
} from "@/lib/r2-usage";

export const dynamic = "force-dynamic";

/** Resume litestream replication after the R2 free-tier kill-switch auto-disabled it.
 *  Removes the persistent marker and restarts the container (the process exits, so the
 *  caller may see a connection reset — the resume still happened). */
export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const result = await resumeR2Replication();
  return NextResponse.json(
    {
      ...result,
      note: result.resumed
        ? "Marker removed; container restarting under litestream replicate. The connection may drop as the process exits."
        : undefined,
    },
    { status: result.resumed || result.reason === "not_disabled" ? 200 : 500 },
  );
}

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const cfg = loadR2UsageMonitorConfig();
  return NextResponse.json({
    replicationDisabled: isR2ReplicationDisabled(cfg),
    autoDisableArmed: isR2AutoDisableArmed(cfg),
    disableMarkerPath: cfg.disableMarkerPath,
  });
}
