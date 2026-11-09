import { createSocraticFrameworkProposal, listSocraticFrameworkProposals } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import type { SocraticFrameworkProposal } from "@/lib/types";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const SUBSYSTEMS = new Set<SocraticFrameworkProposal["subsystem"]>(["strategy", "risk", "sizing", "universe", "evidence", "coaching"]);
const PRIORITIES = new Set<SocraticFrameworkProposal["priority"]>(["low", "medium", "high"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const userId = resolveRequestUserId(request);
  const limit = Number(url.searchParams.get("limit") ?? 25);
  const status = url.searchParams.get("status") as SocraticFrameworkProposal["status"] | null;
  const connectedAccountId = url.searchParams.get("connectedAccountId") ?? undefined;
  return NextResponse.json(listSocraticFrameworkProposals(userId, { limit, status: status ?? undefined, connectedAccountId }));
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const userId = resolveRequestUserId(request);
  const subsystem = SUBSYSTEMS.has(body.subsystem) ? body.subsystem : "coaching";
  const priority = PRIORITIES.has(body.priority) ? body.priority : "medium";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const rationale = typeof body.rationale === "string" ? body.rationale.trim() : "";
  const proposedChange = typeof body.proposedChange === "string" ? body.proposedChange.trim() : "";
  if (!title || !rationale || !proposedChange) {
    return NextResponse.json({ error: "title, rationale, and proposedChange are required" }, { status: 400 });
  }
  const id = createSocraticFrameworkProposal({
    userId,
    connectedAccountId: typeof body.connectedAccountId === "string" ? body.connectedAccountId : undefined,
    decisionId: typeof body.decisionId === "string" ? body.decisionId : undefined,
    runId: typeof body.runId === "string" ? body.runId : undefined,
    subsystem,
    priority,
    title: title.slice(0, 160),
    rationale: rationale.slice(0, 4000),
    proposedChange: proposedChange.slice(0, 4000),
    evidence: []
  });
  return NextResponse.json({ id }, { status: 201 });
}
