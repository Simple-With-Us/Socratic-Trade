import { audit, updateSocraticFrameworkProposalStatus } from "@/lib/db";
import { applyAcceptedFrameworkProposal } from "@/lib/framework-applier";
import { resolveRequestUserIdOrResponse } from "@/lib/request-user";
import type { SocraticFrameworkOwnerVerb, SocraticFrameworkProposalStatus } from "@/lib/types";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const STATUSES = new Set<SocraticFrameworkProposalStatus>(["pending", "accepted", "rejected", "applied"]);
const OWNER_VERBS = new Set<SocraticFrameworkOwnerVerb>(["accept", "reject", "rewrite"]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const body = await request.json().catch(() => ({}));
  const status = body.status;
  if (!STATUSES.has(status)) return NextResponse.json({ error: "invalid status" }, { status: 400 });
  const ownerResponse = typeof body.ownerResponse === "string" ? body.ownerResponse.trim() : undefined;
  const ownerVerb = OWNER_VERBS.has(body.ownerVerb) ? body.ownerVerb : undefined;
  if (ownerVerb === "rewrite" && status !== "accepted") {
    return NextResponse.json({ error: "rewrite must use accepted status" }, { status: 400 });
  }
  if (ownerVerb === "rewrite" && !ownerResponse) {
    return NextResponse.json({ error: "rewrite requires ownerResponse" }, { status: 400 });
  }
  const { id } = await context.params;
  const userId = resolveRequestUserIdOrResponse(request);
  if (userId instanceof Response) return userId;
  const proposal = updateSocraticFrameworkProposalStatus(id, status, userId, ownerResponse, ownerVerb);
  if (!proposal) return NextResponse.json({ error: "framework proposal not found" }, { status: 404 });
  // OD-9 D4b: an ACCEPTED proposal emits its advisory strategy_overlays row here
  // (propose authority + owner-adjustable tuning override gate inside the applier).
  // Advisory only — the overlay is prompt DATA for the proposer, never a cap or gate.
  if (proposal.status === "accepted") {
    const applied = applyAcceptedFrameworkProposal(proposal);
    if (applied.emitted) {
      audit("socratic_framework_applied_as_overlay", { id, overlayId: applied.overlayId }, userId, proposal.connectedAccountId);
    } else if (applied.skippedReason) {
      audit(
        "socratic_framework_overlay_emission_skipped",
        { id, reason: applied.skippedReason },
        userId,
        proposal.connectedAccountId
      );
    }
  }
  return NextResponse.json(proposal);
}
