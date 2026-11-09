import { applyProfileToAccount } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Copy a saved library strategy into a CHOSEN connected account's live state.
// Body: { connectedAccountId: string }. Unlike activate (which targets the active account and
// flips the library active flag), this only writes the target account's live row — and never
// changes that account's run-state.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const body = (await request.json().catch(() => ({}))) as { connectedAccountId?: string };
    const connectedAccountId = body.connectedAccountId?.trim();
    if (!connectedAccountId) {
      return new NextResponse("connectedAccountId is required.", { status: 400 });
    }
    return NextResponse.json(applyProfileToAccount(id, connectedAccountId, resolveRequestUserId(request)));
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "Copy to account failed.", { status: 400 });
  }
}
