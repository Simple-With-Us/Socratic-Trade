import { activateStrategyProfile } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    return NextResponse.json(activateStrategyProfile(id, resolveRequestUserId(request)));
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "Profile activation failed.", { status: 400 });
  }
}
