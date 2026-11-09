import { getMobileCommand } from "@/lib/mobile-api";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = resolveRequestUserId(request);
  const { id } = await params;
  const command = getMobileCommand(id, userId);
  if (!command) return NextResponse.json({ error: "Command not found." }, { status: 404 });
  return NextResponse.json({ command });
}
