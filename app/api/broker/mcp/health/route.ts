import { NextRequest, NextResponse } from "next/server";
import { getRobinhoodMcpHealth } from "@/lib/robinhood";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const userId = resolveRequestUserId(request);
    return NextResponse.json(await getRobinhoodMcpHealth(userId));
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        configured: false,
        authenticated: false,
        tools: [],
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Robinhood MCP health check failed."
      },
      { status: 500 }
    );
  }
}
