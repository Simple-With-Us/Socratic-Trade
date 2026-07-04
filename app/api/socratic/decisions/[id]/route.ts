import { getSocraticDecisionCase } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const userId = resolveRequestUserId(request);
  const decision = getSocraticDecisionCase(id, userId);
  if (!decision) return NextResponse.json({ error: "decision not found" }, { status: 404 });
  return NextResponse.json(decision);
}
