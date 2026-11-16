import { listMobileCommands, mobileControlCatalog, mobileReadiness } from "@/lib/mobile-api";
import { resolveRequestUserOrResponse } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = resolveRequestUserOrResponse(request);
  if (user instanceof Response) return user;
  return NextResponse.json({
    currentUser: user,
    catalog: mobileControlCatalog(),
    readiness: mobileReadiness(user.userId),
    recentCommands: listMobileCommands({ userId: user.userId, limit: 20 })
  });
}
