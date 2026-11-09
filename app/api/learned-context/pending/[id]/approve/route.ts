import { audit, getPendingLearnedContext, setPendingLearnedContextStatus } from "@/lib/db";
import { applyApprovedPending } from "@/lib/learned-context/store";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// POST /api/learned-context/pending/[id]/approve — apply an approved risk-tier candidate SAFELY.
//   strategy-directive → append attributed AI-LEARNED block to the strategy prompt (idempotent by id).
//   risk               → promote to an advisory learned_context row.
// NEVER calls setPolicy / auto-mutates numeric policy. Ownership 404 mirrors the [id]-route pattern.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const userId = resolveRequestUserId(request);
    const pending = getPendingLearnedContext(id, userId);
    if (!pending || pending.status !== "pending") {
      return new NextResponse("Pending learned-context item not found.", { status: 404 });
    }

    // Apply per tier (safe: advisory promote / prompt append — never numeric policy), then resolve.
    applyApprovedPending(pending);
    const updated = setPendingLearnedContextStatus(id, userId, "approved");
    if (!updated) return new NextResponse("Pending learned-context item not found.", { status: 404 });

    audit(
      "learned_context.approve",
      { userId, pendingId: id, tier: pending.riskTier, subject: pending.subject },
      userId
    );
    return NextResponse.json({ status: "approved", tier: pending.riskTier });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to approve pending learned-context item.";
    return new NextResponse(message, { status: 400 });
  }
}
