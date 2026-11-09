import { rejectProposal } from "@/lib/strategy";
import { getPolicy, getProposal } from "@/lib/db";
import { invalidateDashboardSnapshotCache } from "@/lib/dashboard-snapshot-cache";
import { STOPPED_PROPOSAL_ACTION_MESSAGE, isProposalActionStopped } from "@/lib/proposal-actions";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const userId = resolveRequestUserId(request);
    if (!getProposal(id, userId)) {
      return NextResponse.json({ error: "not_found", message: "Proposal not found." }, { status: 404 });
    }
    if (isProposalActionStopped(getPolicy(userId))) {
      return NextResponse.json(
        { error: "system_stopped", message: STOPPED_PROPOSAL_ACTION_MESSAGE },
        { status: 409 }
      );
    }
    rejectProposal(id, userId);
    // C1: pending list changed — next dashboard poll must recompute.
    invalidateDashboardSnapshotCache(userId);
    return NextResponse.json({ status: "rejected" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reject proposal.";
    return NextResponse.json({ error: "bad_request", message }, { status: 400 });
  }
}
