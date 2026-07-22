import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  isValidMobileAuthState,
  isValidPkceChallenge,
  issueMobileAuthExchange
} from "@/lib/mobile-auth-exchange";
import { resolvePublicAppOrigin } from "@/lib/public-origin";

// Auth.js redirects here after Google/GitHub login. The custom scheme receives only a short-lived,
// PKCE-bound one-time code; the raw session JWT never leaves HTTPS or appears in a callback URL.
export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const state = requestUrl.searchParams.get("state");
  const codeChallenge = requestUrl.searchParams.get("code_challenge");
  const publicOrigin = resolvePublicAppOrigin(request);
  if (!isValidMobileAuthState(state) || !isValidPkceChallenge(codeChallenge)) {
    return NextResponse.redirect(new URL("/login?error=MobileAuthInvalidState", publicOrigin));
  }

  const cookieStore = await cookies();
  const token =
    cookieStore.get("__Secure-authjs.session-token")?.value ||
    cookieStore.get("authjs.session-token")?.value;

  if (!token) {
    return NextResponse.redirect(new URL("/login?error=MobileAuthFailed", publicOrigin));
  }

  const { code } = issueMobileAuthExchange({ sessionToken: token, state, codeChallenge });
  const callbackUrl = new URL("socratictrade://auth");
  callbackUrl.searchParams.set("code", code);
  callbackUrl.searchParams.set("state", state);
  const response = NextResponse.redirect(callbackUrl, 303);
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
