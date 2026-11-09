import { NextRequest, NextResponse } from "next/server";
import { clearMcpOAuthTokens } from "@/lib/mcp-oauth";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";

/** DELETE /api/auth/robinhood/tokens — disconnect the calling user's Robinhood OAuth token. */
export async function DELETE(request: NextRequest) {
  try {
    const userId = resolveRequestUserId(request);
    clearMcpOAuthTokens(userId);
    return NextResponse.json({ disconnected: true });
  } catch (error) {
    return NextResponse.json(
      { disconnected: false, error: error instanceof Error ? error.message : "Failed to disconnect Robinhood." },
      { status: 500 }
    );
  }
}
