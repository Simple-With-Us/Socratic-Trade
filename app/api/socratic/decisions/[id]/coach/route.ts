import { attachSocraticDecisionCoachPrimitives } from "@/lib/db";
import type { SocraticFrameworkProposal } from "@/lib/types";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const body = await request.json().catch(() => ({}));
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note) return NextResponse.json({ error: "note is required" }, { status: 400 });
  if (note.length > 4000) return NextResponse.json({ error: "note must be 4000 characters or fewer" }, { status: 400 });
  const promoteTo = body.promoteTo === "lesson" || body.promoteTo === "framework" ? body.promoteTo : undefined;
  const framework = body.framework && typeof body.framework === "object" ? body.framework as Record<string, unknown> : undefined;
  const subsystem = framework?.subsystem;
  const priority = framework?.priority;
  const { id } = await context.params;
  const userId = resolveRequestUserId(request);
  const result = await attachSocraticDecisionCoachPrimitives(
    id,
    {
      note,
      promoteTo,
      lessonText: typeof body.lessonText === "string" ? body.lessonText.trim() : undefined,
      framework: framework
        ? {
            subsystem: subsystem === "strategy" || subsystem === "risk" || subsystem === "sizing" || subsystem === "universe" || subsystem === "evidence" || subsystem === "coaching"
              ? (subsystem as SocraticFrameworkProposal["subsystem"])
              : "coaching",
            priority: priority === "low" || priority === "medium" || priority === "high" ? priority : "medium",
            title: typeof framework.title === "string" ? framework.title.trim() : "",
            rationale: typeof framework.rationale === "string" ? framework.rationale.trim() : "",
            proposedChange: typeof framework.proposedChange === "string" ? framework.proposedChange.trim() : ""
          }
        : undefined
    },
    userId
  );
  if (!result) return NextResponse.json({ error: "decision not found" }, { status: 404 });
  return NextResponse.json(result);
}
