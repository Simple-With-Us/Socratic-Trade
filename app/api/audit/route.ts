import { listAudit } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return NextResponse.json(listAudit(200, resolveRequestUserId(request)));
}
