import { NextResponse } from "next/server";
import { issueMobileHandoffPrepare } from "@/lib/auth/mobile-handoff-prepare";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST — bind a PKCE code_challenge to a server-issued handoff nonce before OAuth begins. */
export async function POST(request: Request) {
  const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "unknown-ip";
  const limited = enforceRateLimit(clientIp, "mobile/auth/handoff-prepare", RATE_LIMITS.oauth);
  if (limited) return limited;

  const body = (await request.json().catch(() => ({}))) as { codeChallenge?: unknown };
  const codeChallenge = typeof body.codeChallenge === "string" ? body.codeChallenge : "";
  const nonce = issueMobileHandoffPrepare(codeChallenge);
  if (!nonce) {
    return NextResponse.json({ error: "Invalid code_challenge." }, { status: 400 });
  }
  return NextResponse.json({ nonce });
}
