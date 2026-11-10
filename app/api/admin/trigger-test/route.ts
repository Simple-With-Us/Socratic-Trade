import { NextResponse } from "next/server";
import { admitRun, submitMaterialEvent, triggerEngineEnabled, triggerMode } from "@/lib/triggers";
import { resolveRequestUserId } from "@/lib/request-user";
import { requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Dev/ops route to inspect the event-driven trigger engine and preview the admitRun gate.
// GET = show engine state + the admit decision for a sample event. POST = submit a test event
// (no-op unless TRIGGER_ENGINE=on and mode != interval). Admin-gated by a middleware-verified
// primary/allowlisted admin email or a timing-safe x-admin-token; there is no environment bypass.
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const userId = resolveRequestUserId(request);
  return NextResponse.json({
    ok: true,
    engineEnabled: triggerEngineEnabled(),
    mode: triggerMode(),
    admitPreview: admitRun(userId, [{ type: "test", symbol: "AAPL", sourceId: "diagnostic" }])
  });
}

export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const userId = resolveRequestUserId(request);
  let symbol = "AAPL";
  try {
    const body = (await request.json()) as { symbol?: string };
    if (body?.symbol) symbol = String(body.symbol);
  } catch {
    // default
  }
  submitMaterialEvent(userId, { type: "test", symbol, sourceId: `diagnostic-${symbol}-${Date.now()}` });
  return NextResponse.json({
    ok: true,
    submitted: { symbol },
    engineEnabled: triggerEngineEnabled(),
    mode: triggerMode(),
    note: "Event submitted. No-op unless TRIGGER_ENGINE=on and mode != interval; gated by admitRun."
  });
}
