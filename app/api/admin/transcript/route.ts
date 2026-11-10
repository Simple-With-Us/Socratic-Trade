// Admin chat transcript: the READ that backs Admin > Chat Transcript.
//
// Why this exists instead of reusing `/api/chat-history`: that route is the ordinary per-caller
// endpoint the console Coach (app/console/assistant/chat.tsx) and the iOS Coach
// (ios/SocraticTrade/MobileAPIClient.swift) both read and DELETE. It is correctly scoped to the
// caller's own turns and correctly NOT admin-gated — putting requireAdmin on it would break chat for
// every non-admin user. But the admin page pointed at it while its nav promised "Every chat turn",
// so the label and the behavior disagreed.
//
// This route is the admin-scoped read that makes the label true: requireAdmin-gated, and genuinely
// unscoped across users. Each turn carries its `userId` so the page can attribute it.
//
// READ only. There is deliberately no POST/DELETE here — see the header of
// app/api/chat-history/route.ts for why a free-form transcript writer must never come back.
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { listAllTurns, MAX_ADMIN_TURNS } from "@/lib/chat-history";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const limit = Number(new URL(request.url).searchParams.get("limit") ?? MAX_ADMIN_TURNS);
  return NextResponse.json({ turns: listAllTurns(limit) });
}
