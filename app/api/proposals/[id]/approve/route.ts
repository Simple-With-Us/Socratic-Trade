import { executeProposal, LiveApprovalConfirmationError, type LiveApprovalConfirmation } from "@/lib/strategy";
import { getPolicy } from "@/lib/db";
import { STOPPED_PROPOSAL_ACTION_MESSAGE, isProposalActionStopped } from "@/lib/proposal-actions";
import { resolveRequestUserId } from "@/lib/request-user";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { NextResponse } from "next/server";

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
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LiveApprovalConfirmationError) {
      return NextResponse.json(
        { error: error.code, reasons: error.reasons, expectedText: error.expectedText },
        { status: 409 }
      );
    }
    const message = error instanceof Error ? error.message : "Failed to execute proposal.";
    if (message === "Proposal not found.") return new NextResponse(message, { status: 404 });
    return new NextResponse(message, { status: 400 });
  }
}
