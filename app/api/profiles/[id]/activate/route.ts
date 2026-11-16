import { activateStrategyProfile } from "@/lib/db";
import { resolveRequestUserIdOrResponse } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const PROFILE_NOT_FOUND = "Strategy profile not found.";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  // Identity/session denials come back as a 401/409 Response. Any other error thrown here is a
  // server fault, so it is resolved outside the try and surfaces as a 500, not a 400.
  const userId = resolveRequestUserIdOrResponse(request);
  if (userId instanceof Response) return userId;
  try {
    return NextResponse.json(activateStrategyProfile(id, userId));
  } catch (error) {
    // Only the expected client error is answered here (404, matching PUT/DELETE /api/profiles/[id]).
    // Database and other server faults propagate as a 500 without echoing internal error text.
    if (error instanceof Error && error.message === PROFILE_NOT_FOUND) {
      return new NextResponse(PROFILE_NOT_FOUND, { status: 404 });
    }
    throw error;
  }
}
