import { resolveRequestUserIdOrResponse } from "@/lib/request-user";
import { forget, ingestMessage, listMemories, retrieve } from "@/lib/memory/store";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = resolveRequestUserIdOrResponse(request);
  if (userId instanceof Response) return userId;
  const mode = new URL(request.url).searchParams.get("mode");
  return NextResponse.json({ memories: mode === "retrieve" ? retrieve(userId) : listMemories(userId) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { message?: unknown; userId?: unknown };
  const userId = resolveRequestUserIdOrResponse(request, body);
  if (userId instanceof Response) return userId;
  if (typeof body.message !== "string") {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }
  return NextResponse.json(ingestMessage(userId, body.message));
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; userId?: unknown };
  const userId = resolveRequestUserIdOrResponse(request, body);
  if (userId instanceof Response) return userId;
  const id = typeof body.id === "string" ? body.id : url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  return NextResponse.json({ forgotten: forget(userId, id) });
}
