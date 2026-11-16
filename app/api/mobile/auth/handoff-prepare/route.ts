import "server-only";
import { NextResponse } from "next/server";
import { issueMobileHandoffPrepare } from "@/lib/auth/mobile-handoff-prepare";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import {
  HANDOFF_PREPARE_MAX_BYTES,
  HandoffPrepareBodySchema,
} from "@/lib/auth/mobile-auth-schemas";
import { PayloadTooLargeError, readJsonWithLimit } from "@/lib/bounded-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST — bind a PKCE code_challenge to a server-issued handoff nonce before OAuth begins. */
export async function POST(request: Request) {
  const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "unknown-ip";
  const limited = enforceRateLimit(clientIp, "mobile/auth/handoff-prepare", RATE_LIMITS.oauth);
  if (limited) return limited;

  try {
    const body = await readJsonWithLimit(request, HANDOFF_PREPARE_MAX_BYTES);
    const parsed = HandoffPrepareBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid code_challenge." }, { status: 400 });
    }
    const nonce = issueMobileHandoffPrepare(parsed.data.codeChallenge);
    if (!nonce) {
      return NextResponse.json({ error: "Invalid code_challenge." }, { status: 400 });
    }
    return NextResponse.json({ nonce });
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
    }
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
