import { activateStrategyProfile } from "@/lib/db";
import { resolveRequestUserIdOrResponse } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const userId = resolveRequestUserIdOrResponse(request);
    if (userId instanceof Response) return userId;
    return NextResponse.json(activateStrategyProfile(id, userId));
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "Profile activation failed.", { status: 400 });
  }
}
