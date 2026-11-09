import { listLearnedContext } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// GET /api/learned-context — everything durably recorded for this user: silent fact-tier rows
// (auto-passed, never queued) plus any risk-tier / strategy-directive rows they approved from the
// pending queue. Read-only browse surface for the "what has the AI learned so far" list; mutation
// happens only via DELETE /api/learned-context/[id].
export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  return NextResponse.json(listLearnedContext(userId));
}
