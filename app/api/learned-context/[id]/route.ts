import { audit, deleteLearnedContext } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// DELETE /api/learned-context/[id] — erase a durably-recorded learned-context row (fact-tier or an
// approved risk/strategy-directive row). Ownership is enforced inside deleteLearnedContext itself
// (DELETE ... WHERE id = ? AND user_id = ?), so a foreign or missing id is indistinguishable from a
// 404 here — never leaks whether the row exists under another user.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const userId = resolveRequestUserId(request);
    const deleted = deleteLearnedContext(id, userId);
    if (!deleted) return new NextResponse("Learned-context item not found.", { status: 404 });

    audit("learned_context.delete", { userId, id }, userId);
    return NextResponse.json({ status: "deleted" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete learned-context item.";
    return new NextResponse(message, { status: 400 });
  }
}
