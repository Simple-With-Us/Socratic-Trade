import { listPendingLearnedContext } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// GET /api/learned-context/pending — list this user's pending risk-tier confirmation queue.
export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  return NextResponse.json(listPendingLearnedContext(userId, "pending"));
}
