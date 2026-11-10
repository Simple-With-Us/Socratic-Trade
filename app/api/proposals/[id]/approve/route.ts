import { getPolicy } from "@/lib/db";
import { invalidateDashboardSnapshotCache } from "@/lib/dashboard-snapshot-cache";
import { STOPPED_PROPOSAL_ACTION_MESSAGE, isProposalActionStopped } from "@/lib/proposal-actions";
import { resolveRequestUserId } from "@/lib/request-user";
import { httpStatusForPlacement, resolvePlacementOutcome } from "@/lib/placement-outcome";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { NextResponse } from "next/server";
import { executeProposal, LiveApprovalConfirmationError, LiveApprovalConfirmation } from "@/lib/strategy-execution";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      liveConfirmation?: LiveApprovalConfirmation;
      userId?: unknown;
    };
    const userId = resolveRequestUserId(request, body);
    const limited = enforceRateLimit(userId, "proposals/approve", RATE_LIMITS.orders);
    if (limited) return limited;
    if (isProposalActionStopped(getPolicy(userId))) {
      return NextResponse.json(
        { error: "system_stopped", message: STOPPED_PROPOSAL_ACTION_MESSAGE },
        { status: 409 }
      );
    }
    const { id } = await params;
    const result = await executeProposal(id, userId, { liveConfirmation: body.liveConfirmation });
    const placement = resolvePlacementOutcome(result);
    // C1: order/proposal state changed — next dashboard poll must recompute.
    invalidateDashboardSnapshotCache(userId);
    // 200 only when the broker accepted the order.  busy / blocked / not placed
    // stay structured so the client can tell them apart, and they are not success.
    return NextResponse.json(placement, { status: httpStatusForPlacement(placement.outcome) });
  } catch (error) {
    if (error instanceof LiveApprovalConfirmationError) {
      return NextResponse.json(
        { error: error.code, reasons: error.reasons, expectedText: error.expectedText },
        { status: 409 }
      );
    }
    const message = error instanceof Error ? error.message : "Failed to execute proposal.";
    if (message === "Proposal not found.") {
      return NextResponse.json({ error: "not_found", message }, { status: 404 });
    }
    return NextResponse.json({ error: "bad_request", message }, { status: 400 });
  }
}
