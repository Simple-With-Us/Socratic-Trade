import { NextRequest, NextResponse } from "next/server";
import { buildMcpAuthorizationUrl, resolveMcpOAuthRedirectUri } from "@/lib/mcp-oauth";
import { resolveRequestUserId } from "@/lib/request-user";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const userId = resolveRequestUserId(request);
    const limited = enforceRateLimit(userId, "auth/robinhood/start", RATE_LIMITS.oauth);
    if (limited) return limited;
    return NextResponse.redirect(await buildMcpAuthorizationUrl(userId, { redirectUri: resolveMcpOAuthRedirectUri(request) }));
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "Robinhood MCP OAuth start failed.", { status: 500 });
  }
}
