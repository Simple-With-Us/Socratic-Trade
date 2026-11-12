import { activateStrategyProfile } from "@/lib/db";
import { resolveRequestUserIdOrResponse } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  // Identity/session denials come back as a 401/409 Response. Any other error thrown here is a
  // server fault, so it is resolved outside the try and surfaces as a 500, not a 400.
  const userId = resolveRequestUserIdOrResponse(request);
  if (userId instanceof Response) return userId;
  try {
    return NextResponse.json(activateStrategyProfile(id, userId));
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "Profile activation failed.", { status: 400 });
  }
}
