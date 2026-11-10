import { NextResponse } from "next/server";
import {
  createStrategyOverlay,
  listStrategyOverlays,
  seedStrategyOverlayTemplates
} from "@/lib/db-overlays";
import { parseOverlayRegimes, type OverlayRegimeTag } from "@/lib/overlay-router";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  return NextResponse.json({ overlays: listStrategyOverlays(userId) });
}

export async function POST(request: Request) {
  const userId = resolveRequestUserId(request);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (body.seed === true) {
    return NextResponse.json({ overlays: seedStrategyOverlayTemplates(userId), seeded: true });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const instructions = typeof body.instructions === "string" ? body.instructions : "";
  if (!name || !instructions.trim()) {
    return NextResponse.json({ error: "Name and instructions are required." }, { status: 400 });
  }
  const overlay = createStrategyOverlay({
    userId,
    name,
    instructions,
    marketRegimes: parseOverlayRegimes(body.marketRegimes) as OverlayRegimeTag[],
    priority: typeof body.priority === "number" ? body.priority : undefined,
    enabled: body.enabled === false ? false : true
  });
  return NextResponse.json({ overlay });
}
