import { NextRequest, NextResponse } from "next/server";
import { completeMcpOAuthCallback, resolvePublicAppOrigin } from "@/lib/mcp-oauth";
import { resolveRequestUserFromEmail } from "@/lib/request-user";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { getSessionEmail } from "@/lib/auth/session-edge";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  // Production is Cloudflare-fronted, so only its overwritten connecting-IP header is a trusted
  // client address here. A direct caller can forge X-Forwarded-For; requests without the CF header
  // deliberately share one conservative fallback bucket instead of minting attacker-chosen keys.
  const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "unknown-ip";
  // This route is public because the OAuth provider calls it without an app session. Rate-limit on
  // the proxy-provided client IP BEFORE state lookup: `state` is attacker-controlled at this point,
  // so including it in the key lets a caller mint a fresh bucket on every request and defeats both
  // throttling and the limiter's memory bound.
  const limited = enforceRateLimit(clientIp, "auth/robinhood/callback", RATE_LIMITS.oauth);
  if (limited) return limited;

  if (error) {
    const description = url.searchParams.get("error_description");
    return new NextResponse(description ? `${error}: ${description}` : error, { status: 400 });
  }

  if (!code || !state) return new NextResponse("Missing OAuth code or state.", { status: 400 });

  try {
    // This is a public middleware path, so middleware intentionally strips identity headers. A
    // same-browser Auth.js cookie is optional but, when present, verify its signature here and
    // cross-check it against the initiating state owner. Provider callbacks without that cookie
    // remain securely bound by the one-time, high-entropy server-side state row.
    const sessionEmail = process.env.AUTH_SECRET
      ? await getSessionEmail(request.headers.get("cookie"), process.env.AUTH_SECRET)
      : null;
    const expectedUserId = sessionEmail ? resolveRequestUserFromEmail(sessionEmail).userId : undefined;
    await completeMcpOAuthCallback({ code, state, expectedUserId });
    return NextResponse.redirect(new URL("/console/connections?robinhoodMcp=connected", resolvePublicAppOrigin(request)));
  } catch (callbackError) {
    return new NextResponse(callbackError instanceof Error ? callbackError.message : "Robinhood MCP OAuth callback failed.", {
      status: 500
    });
  }
}

export async function POST(request: NextRequest) {
  const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "unknown-ip";
  const limited = enforceRateLimit(clientIp, "auth/robinhood/callback", RATE_LIMITS.oauth);
  if (limited) return limited;

  try {
    const body = (await request.json().catch(() => ({}))) as { url?: string; code?: string; state?: string };
    let code = body.code?.trim();
    let state = body.state?.trim();
    if (body.url) {
      try {
        const parsed = new URL(body.url.trim());
        code = parsed.searchParams.get("code")?.trim() || code;
        state = parsed.searchParams.get("state")?.trim() || state;
      } catch {
        // ignore malformed URL and fall back to code/state fields
      }
    }
    if (!code || !state) {
      return NextResponse.json({ ok: false, error: "Missing OAuth code or state parameter." }, { status: 400 });
    }
    const sessionEmail = process.env.AUTH_SECRET
      ? await getSessionEmail(request.headers.get("cookie"), process.env.AUTH_SECRET)
      : null;
    const expectedUserId = sessionEmail ? resolveRequestUserFromEmail(sessionEmail).userId : undefined;
    await completeMcpOAuthCallback({ code, state, expectedUserId });
    return NextResponse.json({ ok: true, connected: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Robinhood MCP OAuth callback completion failed." },
      { status: 500 }
    );
  }
}
