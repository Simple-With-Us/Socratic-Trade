import { getProposal, getSocraticDecisionCase, getStrategyRunById } from "@/lib/db";
import type { SocraticDecisionTrace } from "@/lib/types";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const userId = resolveRequestUserId(request);
  const decision = getSocraticDecisionCase(id, userId);
  if (!decision) return NextResponse.json({ error: "decision not found" }, { status: 404 });
  // Join the linked proposal's persisted scorecard for the trace's read-only render — the case
  // itself stores no duplicate copy. Absent for legacy/portfolio cases; never fabricated.
  const scorecard = getProposal(decision.proposalId ?? decision.id, userId)?.proposal.scorecard;
  const payload: SocraticDecisionTrace = {
    decision,
    ...(decision.runId ? { run: getStrategyRunById(decision.runId, userId) } : {}),
    ...(scorecard ? { scorecard } : {})
  };
  return NextResponse.json(payload);
}
