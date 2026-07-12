import { NextResponse } from "next/server";
import { refreshCongress, getCongressDataset } from "@/lib/web-sources/congress";
import { refreshEightK, getEightKDataset } from "@/lib/web-sources/sec8k";
import { requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

// Dev/ops route to force a web-source refresh (bypasses TTL/backoff) and report the result.
// Admin-gated: verified ADMIN_USER_EMAILS / primary operator, or x-admin-token, or non-production.
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

  if (id === "congress") {
    const result = await refreshCongress(Date.now(), true);
    const ds = getCongressDataset();
    const byChamber = (ds?.trades ?? []).reduce<Record<string, number>>((acc, t) => {
      acc[t.chamber] = (acc[t.chamber] ?? 0) + 1;
      return acc;
    }, {});
    return NextResponse.json({ ok: result.ok, id, result, recordCount: ds?.recordCount ?? 0, byChamber, sources: ds?.sources ?? [] });
  }
  if (id === "sec8k") {
    const result = await refreshEightK(Date.now(), true);
    return NextResponse.json({ ok: result.ok, id, result, recordCount: getEightKDataset()?.recordCount ?? 0 });
  }
  return NextResponse.json({ ok: false, error: `Unknown web-source id: ${id} (supported: congress, sec8k)` }, { status: 400 });
}
