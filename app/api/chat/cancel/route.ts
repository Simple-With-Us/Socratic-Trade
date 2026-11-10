import { resolveRequestUserId } from "@/lib/request-user";
import { cancelChatTurn } from "@/lib/chat/turn-registry";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const userId = resolveRequestUserId(request);
  const body = (await request.json().catch(() => ({}))) as { turnKey?: unknown; clientTurnId?: unknown };
  const rawKey =
    typeof body.turnKey === "string" && body.turnKey.trim()
      ? body.turnKey.trim()
      : typeof body.clientTurnId === "string" && body.clientTurnId.trim()
        ? `chat:${userId}:${body.clientTurnId.trim()}`
        : "";
  if (!rawKey) {
    return NextResponse.json({ error: "turnKey or clientTurnId is required" }, { status: 400 });
  }
  const cancelled = cancelChatTurn(rawKey, userId);
  if (!cancelled) {
    return NextResponse.json({ error: "turn_not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
