import { NextResponse } from "next/server";
import { deleteStrategyOverlay, updateStrategyOverlay } from "@/lib/db-overlays";
import { parseOverlayRegimes } from "@/lib/overlay-router";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = resolveRequestUserId(request);
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  const overlay = updateStrategyOverlay(userId, id, {
    name: typeof body.name === "string" ? body.name : undefined,
    instructions: typeof body.instructions === "string" ? body.instructions : undefined,
    marketRegimes: body.marketRegimes !== undefined ? parseOverlayRegimes(body.marketRegimes) : undefined,
    priority: typeof body.priority === "number" ? body.priority : undefined,
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined
  });
  if (!overlay) return NextResponse.json({ error: "Overlay not found." }, { status: 404 });
  return NextResponse.json({ overlay });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = resolveRequestUserId(_request);
  const { id } = await context.params;
  const ok = deleteStrategyOverlay(userId, id);
  if (!ok) return NextResponse.json({ error: "Overlay not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
