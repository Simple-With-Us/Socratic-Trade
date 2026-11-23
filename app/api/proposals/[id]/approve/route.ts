import { getPolicy } from "@/lib/db";
import { invalidateDashboardSnapshotCache } from "@/lib/dashboard-snapshot-cache";
import { STOPPED_PROPOSAL_ACTION_MESSAGE, isProposalActionStopped } from "@/lib/proposal-actions";
import { resolveRequestUserIdOrResponse } from "@/lib/request-user";
import { httpStatusForPlacement, resolvePlacementOutcome } from "@/lib/placement-outcome";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { NextResponse } from "next/server";
import { executeProposal, LiveApprovalConfirmationError } from "@/lib/strategy-execution";
import { z } from "zod";

export const dynamic = "force-dynamic";

const LiveApprovalConfirmationSchema = z.looseObject({
  proposalId: z.string().nullish(),
  accountNumber: z.string().nullish(),
  executionMode: z.enum(["broker/paper", "broker/live"]).nullish(),
  estimatedNotional: z.number().finite().nullish(),
  typedText: z.string().nullish()
});
const ApproveBodySchema = z.looseObject({
  liveConfirmation: LiveApprovalConfirmationSchema.nullish(),
  userId: z.unknown().optional()
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = resolveRequestUserIdOrResponse(request);
    if (userId instanceof Response) return userId;
    const limited = enforceRateLimit(userId, "proposals/approve", RATE_LIMITS.orders);
    if (limited) return limited;
    const rawBody: unknown = await request.json().catch(() => ({}));
    const parsedBody = ApproveBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return NextResponse.json({ error: "bad_request", message: "Invalid approval payload." }, { status: 400 });
    }
    const body = parsedBody.data;
    if (isProposalActionStopped(getPolicy(userId))) {
      return NextResponse.json(
        { error: "system_stopped", message: STOPPED_PROPOSAL_ACTION_MESSAGE },
        { status: 409 }
      );
    }
    const { id } = await params;
    const liveConfirmation = body.liveConfirmation
      ? {
          proposalId: body.liveConfirmation.proposalId ?? undefined,
          accountNumber: body.liveConfirmation.accountNumber ?? undefined,
          executionMode: body.liveConfirmation.executionMode ?? undefined,
          estimatedNotional: body.liveConfirmation.estimatedNotional ?? undefined,
          typedText: body.liveConfirmation.typedText ?? undefined
        }
      : undefined;
    const result = await executeProposal(id, userId, { liveConfirmation });
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
