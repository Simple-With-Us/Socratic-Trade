import { listPendingLearnedContext } from "@/lib/db";
import { resolveRequestUserIdOrResponse } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// GET /api/learned-context/pending — list this user's pending risk-tier confirmation queue.
export async function GET(request: Request) {
  const userId = resolveRequestUserIdOrResponse(request);
  if (userId instanceof Response) return userId;
  return NextResponse.json(listPendingLearnedContext(userId, "pending"));
}
