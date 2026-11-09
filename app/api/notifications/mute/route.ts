import { resolveRequestUserId } from "@/lib/request-user";
import { getAlertMutes, setAlertMute } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Per-condition Alert Center mutes (#2555): GET returns the user's active mutes
 *  (conditionKey → mutedUntil ISO), POST { key, mute } sets or clears one 24h mute.
 *  Rendering-only and reversible — detection, recording, and delivery are untouched.
 *  Always user-scoped via resolveRequestUserId (mirrors app/api/notifications/ack). */
export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  return NextResponse.json({ mutes: getAlertMutes(userId) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { key?: unknown; mute?: unknown; userId?: unknown };
  const userId = resolveRequestUserId(request, body);
  const key = typeof body.key === "string" && body.key.trim() ? body.key : undefined;
  if (!key) return NextResponse.json({ error: "key is required" }, { status: 400 });
  const mutes = setAlertMute(userId, key, body.mute !== false);
  return NextResponse.json({ mutes });
}
