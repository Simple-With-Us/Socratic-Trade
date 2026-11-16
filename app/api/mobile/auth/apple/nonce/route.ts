import { NextResponse } from "next/server";
import { issueAppleSignInNonce } from "@/lib/auth/apple-signin-nonce";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET — one-time nonce for native Sign in with Apple (verified in identity token). */
export async function GET(request: Request) {
  const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "unknown-ip";
  const limited = enforceRateLimit(clientIp, "mobile/auth/apple/nonce", RATE_LIMITS.oauth);
  if (limited) return limited;
  return NextResponse.json({ nonce: issueAppleSignInNonce() });
}
