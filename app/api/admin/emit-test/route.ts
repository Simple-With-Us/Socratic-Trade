import { NextResponse } from "next/server";
import { emitDashboardEvent, dashboardSubscriberCount } from "@/lib/events";
import { requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Dev/ops route: emit a synthetic dashboard event to verify the SSE push path end-to-end
// (open /api/events/stream, hit this, watch the `dirty` event arrive). Admin-gated by a
// middleware-verified primary/allowlisted admin email or the timing-safe legacy x-admin-token;
// there is no environment bypass.
export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const subscribers = dashboardSubscriberCount();
  emitDashboardEvent({ type: "dirty", at: new Date().toISOString(), detail: { test: true } });
  return NextResponse.json({ ok: true, emitted: "dirty", subscribers });
}
