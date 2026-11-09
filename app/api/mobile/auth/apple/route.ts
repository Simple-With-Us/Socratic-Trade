import "server-only";
import { NextResponse } from "next/server";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { isEmailAllowed, userIdForEmail } from "../../../../../src/lib/auth/identity";
import { encodeSessionToken } from "../../../../../src/lib/auth/session-token";
import { resolveAppleClientIds } from "../../../../../src/lib/auth/apple-client-id";
import { APPLE_AUTH_MAX_BYTES, PayloadTooLargeError, readJsonWithLimit } from "../../../../../src/lib/bounded-body";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { consumeAppleSignInNonce } from "@/lib/auth/apple-signin-nonce";
import {
  absoluteExpUnixSeconds,
  createAuthServerSession,
  slidingMaxAgeSeconds,
} from "@/lib/db-auth-sessions";
import {
  SESSION_JWT_ABS_EXP_CLAIM,
  SESSION_JWT_SID_CLAIM,
  SESSION_JWT_SRV_TOUCH_CLAIM,
} from "@/lib/auth/session-policy";
import {
  logMobileSessionHardeningCompat,
  mobileAppleSignInIsStrict,
} from "@/lib/auth/mobile-session-hardening";
import {
  AppleVerifiedEmailSchema,
  MobileAppleSignInBodySchema,
} from "@/lib/auth/mobile-auth-schemas";

// Module-scope JWKS: jose caches keys per resolver instance; recreate-per-request
// re-fetches https://appleid.apple.com/auth/keys on every sign-in.
const APPLE_JWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

export async function POST(request: Request) {
  const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "unknown-ip";
  const limited = enforceRateLimit(clientIp, "mobile/auth/apple", RATE_LIMITS.oauth);
  if (limited) return limited;

  try {
    const body = await readJsonWithLimit(request, APPLE_AUTH_MAX_BYTES);
    const parsedBody = MobileAppleSignInBodySchema.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json({ error: "Missing or invalid identityToken" }, { status: 400 });
    }
    const { identityToken, name, nonce } = parsedBody.data;
    const nonceValue = nonce ?? "";
    const strictApple = mobileAppleSignInIsStrict(request, nonceValue);
    if (strictApple) {
      if (!nonceValue) {
        return NextResponse.json({ error: "Missing or invalid nonce" }, { status: 400 });
      }
      if (!consumeAppleSignInNonce(nonceValue)) {
        return NextResponse.json({ error: "Invalid or expired nonce" }, { status: 401 });
      }
    } else {
      logMobileSessionHardeningCompat(
        "/api/mobile/auth/apple",
        "missing server nonce from shipped iOS build",
      );
    }

    const { payload } = await jwtVerify(identityToken, APPLE_JWKS, {
      issuer: "https://appleid.apple.com",
      audience: resolveAppleClientIds(),
    });
    if (strictApple && payload.nonce !== nonceValue) {
      return NextResponse.json({ error: "Invalid identity token" }, { status: 401 });
    }

    const emailParsed = AppleVerifiedEmailSchema.safeParse(payload.email);
    if (!emailParsed.success) {
      return NextResponse.json({ error: "Apple token did not contain an email address." }, { status: 400 });
    }
    const email = emailParsed.data;

    if (!isEmailAllowed(email)) {
      return NextResponse.json({ error: "Access denied." }, { status: 403 });
    }

    const authSecret = process.env.AUTH_SECRET;
    if (!authSecret) {
      console.error("AUTH_SECRET is missing");
      return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }

    const salt = process.env.NODE_ENV === "production" ? "__Secure-authjs.session-token" : "authjs.session-token";
    const sessionRecord = createAuthServerSession(userIdForEmail(email));

    const nowSeconds = Math.floor(Date.now() / 1000);
    const sessionJwt = await encodeSessionToken({
      token: {
        email,
        name: (typeof name === "string" ? name : undefined) ?? payload.email,
        loginAt: Date.now(),
        [SESSION_JWT_SID_CLAIM]: sessionRecord.id,
        [SESSION_JWT_ABS_EXP_CLAIM]: absoluteExpUnixSeconds(sessionRecord.absoluteExpiresAt),
        [SESSION_JWT_SRV_TOUCH_CLAIM]: nowSeconds,
      },
      secret: authSecret,
      salt,
      maxAge: slidingMaxAgeSeconds(sessionRecord.absoluteExpiresAt),
    });

    const response = NextResponse.json({ success: true, email });
    const maxAge = slidingMaxAgeSeconds(sessionRecord.absoluteExpiresAt);
    response.cookies.set(salt, sessionJwt, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge,
    });

    return response;
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }
    // readJsonWithLimit surfaces invalid JSON as SyntaxError — reject as 400 before any
    // jwtVerify attempt (test/apple-auth-route.test.ts: rejects malformed JSON).
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
    }
    console.error("Apple Sign-In Verification Error:", error);
    return NextResponse.json({ error: "Invalid identity token" }, { status: 401 });
  }
}
