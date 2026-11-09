import { listSocraticDecisionCases } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const userId = resolveRequestUserId(request);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const connectedAccountId = url.searchParams.get("connectedAccountId") ?? undefined;
  const runId = url.searchParams.get("runId") ?? undefined;
  return NextResponse.json(listSocraticDecisionCases(userId, { limit, connectedAccountId, runId }));
}
