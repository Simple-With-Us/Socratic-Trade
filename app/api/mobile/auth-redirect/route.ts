import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { pickSessionCookie } from "@/lib/auth/session-cookie-names";
import { createMobileAuthHandoff } from "@/lib/mobile-auth-handoff";
import { consumeMobileHandoffPrepare } from "@/lib/auth/mobile-handoff-prepare";
import { decodeSessionToken } from "@/lib/auth/session-token";
import { SESSION_JWT_SID_CLAIM } from "@/lib/auth/session-policy";
import {
  LEGACY_MOBILE_HANDOFF_NONCE,
  LEGACY_MOBILE_SESSION_ID,
  logMobileSessionHardeningCompat,
  mobileOAuthHandoffIsStrict,
} from "@/lib/auth/mobile-session-hardening";

export const runtime = "nodejs";

// This route acts as the callback destination for Auth.js when initiated from the iOS app.
// The iOS app launches ASWebAuthenticationSession pointing to:
// /api/mobile/auth-start?provider=<provider>&callbackUrl=https://socratictrade.com/api/mobile/auth-redirect?code_challenge=...&handoff_nonce=...
// (older shipped builds open GET /api/auth/signin/<provider>, which middleware.ts translates
// to auth-start — Auth.js v5 only initiates OAuth on POST, so that GET alone dead-ends).
//
// Once Auth.js finishes the OAuth flow, it sets the session cookie in the browser and redirects here.
// The native callback carries an opaque, PKCE-bound one-time code only — never the session JWT.
export async function GET(request: Request) {
  const cookieStore = await cookies();
  const url = new URL(request.url);
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  const handoffNonce = url.searchParams.get("handoff_nonce") ?? "";

  const strictHandoff = mobileOAuthHandoffIsStrict(request, handoffNonce);
  if (!codeChallenge) {
    const errorCallback = new URL("socratictrade://auth");
    errorCallback.searchParams.set("error", "MobileAuthInvalidCallback");
    return NextResponse.redirect(errorCallback);
  }
  if (strictHandoff) {
    if (
      !handoffNonce ||
      !consumeMobileHandoffPrepare({ handoffNonce, codeChallenge })
    ) {
      const errorCallback = new URL("socratictrade://auth");
      errorCallback.searchParams.set("error", "MobileAuthInvalidCallback");
      return NextResponse.redirect(errorCallback);
    }
  } else {
    logMobileSessionHardeningCompat(
      "/api/mobile/auth-redirect",
      "missing handoff_nonce from shipped iOS build (PKCE only)",
    );
  }

  const sessionCookie = pickSessionCookie(cookieStore.getAll());

  if (!sessionCookie) {
    const errorCallback = new URL("socratictrade://auth");
    errorCallback.searchParams.set("error", "MobileAuthFailed");
    return NextResponse.redirect(errorCallback);
  }

  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) {
    const errorCallback = new URL("socratictrade://auth");
    errorCallback.searchParams.set("error", "MobileAuthInvalidCallback");
    return NextResponse.redirect(errorCallback);
  }
  const payload = await decodeSessionToken({
    token: sessionCookie.value,
    secret: authSecret,
    salt: sessionCookie.name,
  });
  const sessionId = payload?.[SESSION_JWT_SID_CLAIM];
  const boundSessionId =
    typeof sessionId === "string" && sessionId ? sessionId : LEGACY_MOBILE_SESSION_ID;
  if (strictHandoff && boundSessionId === LEGACY_MOBILE_SESSION_ID) {
    const errorCallback = new URL("socratictrade://auth");
    errorCallback.searchParams.set("error", "MobileAuthInvalidCallback");
    return NextResponse.redirect(errorCallback);
  }

  const code = createMobileAuthHandoff({
    sessionToken: sessionCookie.value,
    cookieName: sessionCookie.name,
    codeChallenge,
    handoffNonce: strictHandoff ? handoffNonce : LEGACY_MOBILE_HANDOFF_NONCE,
    sessionId: boundSessionId,
  });
  if (!code) {
    const errorCallback = new URL("socratictrade://auth");
    errorCallback.searchParams.set("error", "MobileAuthInvalidCallback");
    return NextResponse.redirect(errorCallback);
  }
  const nativeCallback = new URL("socratictrade://auth");
  nativeCallback.searchParams.set("code", code);
  return NextResponse.redirect(nativeCallback);
}
