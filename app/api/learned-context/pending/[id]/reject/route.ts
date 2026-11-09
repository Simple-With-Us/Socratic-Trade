import { audit, getPendingLearnedContext, setPendingLearnedContextStatus } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// POST /api/learned-context/pending/[id]/reject — discard a pending candidate. Nothing is applied:
// no learned_context row, no strategy-prompt change, no policy change. Ownership 404 mirrors the
// existing [id]-route pattern.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const userId = resolveRequestUserId(request);
    const pending = getPendingLearnedContext(id, userId);
    if (!pending || pending.status !== "pending") {
      return new NextResponse("Pending learned-context item not found.", { status: 404 });
    }

    const updated = setPendingLearnedContextStatus(id, userId, "rejected");
    if (!updated) return new NextResponse("Pending learned-context item not found.", { status: 404 });

    audit("learned_context.reject", { userId, pendingId: id, tier: pending.riskTier, subject: pending.subject }, userId);
    return NextResponse.json({ status: "rejected" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reject pending learned-context item.";
    return new NextResponse(message, { status: 400 });
  }
}
