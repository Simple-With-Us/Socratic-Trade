import { NextResponse } from "next/server";
import { refreshCongress, getCongressDataset } from "@/lib/web-sources/congress";
import { refreshEightK, getEightKDataset } from "@/lib/web-sources/sec8k";
import { requireAdmin } from "@/lib/auth/admin";
import { withAdminOperationGuard } from "@/lib/admin-operation-guard";
import { getOperationLeaseBusy, OPERATION_LEASE_GROUPS } from "@/lib/operation-lease";
import { operationLeaseBusyResponse } from "@/lib/operation-guard-response";

export const dynamic = "force-dynamic";

// Dev/ops route to force a web-source refresh (bypasses TTL/backoff) and report the result.
// Admin-gated by a middleware-verified primary/allowlisted admin email or a timing-safe
// x-admin-token; there is no environment bypass.
export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  let id = "congress";
  try {
    const body = (await request.json()) as { id?: string };
    if (body?.id) id = String(body.id);
  } catch {
    // default to congress
  }

  if (id !== "congress" && id !== "sec8k") {
    return NextResponse.json({ ok: false, error: `Unknown web-source id: ${id} (supported: congress, sec8k)` }, { status: 400 });
  }

  const durableGroup = id === "congress"
    ? OPERATION_LEASE_GROUPS.CONGRESS_WEB_SOURCE
    : OPERATION_LEASE_GROUPS.SEC8K_WEB_SOURCE;
  return withAdminOperationGuard(request, "refresh-websource", async (operationLeaseClaim) => {
    if (id === "congress") {
      const result = await refreshCongress(Date.now(), true, operationLeaseClaim);
      const busy = getOperationLeaseBusy(result);
      if (busy) return operationLeaseBusyResponse("refresh-websource", busy);
      const ds = getCongressDataset();
      const byChamber = (ds?.trades ?? []).reduce<Record<string, number>>((acc, t) => {
        acc[t.chamber] = (acc[t.chamber] ?? 0) + 1;
        return acc;
      }, {});
      return NextResponse.json({ ok: result.ok, id, result, recordCount: ds?.recordCount ?? 0, byChamber, sources: ds?.sources ?? [] });
    }
    const result = await refreshEightK(Date.now(), true, operationLeaseClaim);
    const busy = getOperationLeaseBusy(result);
    if (busy) return operationLeaseBusyResponse("refresh-websource", busy);
    return NextResponse.json({ ok: result.ok, id, result, recordCount: getEightKDataset()?.recordCount ?? 0 });
  }, { durableGroup });
}
