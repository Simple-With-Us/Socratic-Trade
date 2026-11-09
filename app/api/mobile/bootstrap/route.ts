import { listMobileCommands, mobileControlCatalog, mobileReadiness } from "@/lib/mobile-api";
import { resolveRequestUser } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = resolveRequestUser(request);
  return NextResponse.json({
    currentUser: user,
    catalog: mobileControlCatalog(),
    readiness: mobileReadiness(user.userId),
    recentCommands: listMobileCommands({ userId: user.userId, limit: 20 })
  });
}
