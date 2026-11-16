import { listAudit } from "@/lib/db";
import { resolveRequestUserIdOrResponse } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = resolveRequestUserIdOrResponse(request);
  if (userId instanceof Response) return userId;
  return NextResponse.json(listAudit(200, userId));
}
