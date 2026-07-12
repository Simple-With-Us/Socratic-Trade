import { NextRequest, NextResponse } from "next/server";
import { completeMcpOAuthCallback, resolvePublicAppOrigin } from "@/lib/mcp-oauth";
import { AUTHENTICATED_EMAIL_HEADER, resolveRequestUserId } from "@/lib/request-user";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  // Providers call the callback without the app session headers. If middleware did verify and
  // forward identity, keep the cross-check; otherwise bind by the one-time stored OAuth state.
  const expectedUserId = request.headers.get(AUTHENTICATED_EMAIL_HEADER) ? resolveRequestUserId(request) : undefined;
  const clientIp =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown-ip";
  const rateLimitSubject = expectedUserId ?? state ?? "missing-state";
  const limited = enforceRateLimit(`${rateLimitSubject}:${clientIp}`, "auth/robinhood/callback", RATE_LIMITS.oauth);
  if (limited) return limited;

  if (error) {
    const description = url.searchParams.get("error_description");
    return new NextResponse(description ? `${error}: ${description}` : error, { status: 400 });
  }

  if (!code || !state) return new NextResponse("Missing OAuth code or state.", { status: 400 });

  try {
    await completeMcpOAuthCallback({ code, state, expectedUserId });
    return NextResponse.redirect(new URL("/console/settings?robinhoodMcp=connected", resolvePublicAppOrigin(request)));
  } catch (callbackError) {
    return new NextResponse(callbackError instanceof Error ? callbackError.message : "Robinhood MCP OAuth callback failed.", {
      status: 500
    });
  }
}
