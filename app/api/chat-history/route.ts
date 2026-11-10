// Chat transcript: READ and CLEAR only.
//
// There is deliberately NO POST here. A turn — above all a `role:"assistant"` turn — may only be
// written by the orchestrator from a model call that actually happened (chat/orchestrator.ts's
// appendTurn). A free-form writer let a caller forge an assistant turn into their own transcript,
// which the admin viewer then showed as real AND orchestrator.ts replayed as trusted prior context
// into that user's next real turn. Nothing on web or iOS ever called it. Do not add it back.
import { resolveRequestUserId } from "@/lib/request-user";
import { clearTurns, listTurns } from "@/lib/chat-history";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? "100");
  return NextResponse.json({ turns: listTurns(userId, limit) });
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { userId?: unknown };
  const userId = resolveRequestUserId(request, body);
  return NextResponse.json({ cleared: clearTurns(userId) });
}
