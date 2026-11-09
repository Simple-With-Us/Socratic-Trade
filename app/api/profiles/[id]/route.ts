import { deleteStrategyProfile, getStrategyProfile, updateStrategyProfile } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const profile = getStrategyProfile(id, resolveRequestUserId(request));
  if (!profile) return new NextResponse("Profile not found.", { status: 404 });
  return NextResponse.json(profile);
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json();
  const userId = resolveRequestUserId(request, body);
  try {
    const profile = updateStrategyProfile(id, {
      name: typeof body.name === "string" ? body.name.trim() : undefined,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      policy: typeof body.policy === "object" && body.policy ? body.policy : undefined,
      scoringWeights: typeof body.scoringWeights === "object" && body.scoringWeights ? body.scoringWeights : undefined
    }, userId);
    return NextResponse.json(profile);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Profile update failed.";
    if (message === "Strategy profile not found.") return new NextResponse(message, { status: 404 });
    return new NextResponse(message, { status: 400 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const userId = resolveRequestUserId(request);
  try {
    deleteStrategyProfile(id, userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Profile delete failed.";
    if (message === "Strategy profile not found.") return new NextResponse(message, { status: 404 });
    return new NextResponse(message, { status: 400 });
  }
}
