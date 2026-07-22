import { NextResponse } from "next/server";
import { signIn } from "@/lib/auth/auth";
import { isValidMobileAuthState, isValidPkceChallenge } from "@/lib/mobile-auth-exchange";
import { resolvePublicAppOrigin } from "@/lib/public-origin";

const MOBILE_WEB_AUTH_PROVIDERS = new Set(["google", "github"]);

function providerIsConfigured(provider: string): boolean {
  if (provider === "google") return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
  if (provider === "github") return Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);
  return false;
}

/**
 * Browser entrypoint for native Google/GitHub auth. `signIn` invokes Auth.js's server-side POST
 * action (including its CSRF handling); the iOS app no longer sends a provider-specific GET to
 * `/api/auth/signin/:provider`, which Auth.js v5 does not use to initiate OAuth.
 */
export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const provider = requestUrl.searchParams.get("provider")?.trim().toLowerCase() ?? "";
  const state = requestUrl.searchParams.get("state");
  const codeChallenge = requestUrl.searchParams.get("code_challenge");

  if (!MOBILE_WEB_AUTH_PROVIDERS.has(provider) || !isValidMobileAuthState(state) || !isValidPkceChallenge(codeChallenge)) {
    return NextResponse.json({ error: "Invalid mobile OAuth request." }, { status: 400 });
  }
  if (!providerIsConfigured(provider)) {
    return NextResponse.json({ error: "Requested OAuth provider is not configured." }, { status: 404 });
  }

  const callbackUrl = new URL("/api/mobile/auth-redirect", resolvePublicAppOrigin(request));
  callbackUrl.searchParams.set("state", state);
  callbackUrl.searchParams.set("code_challenge", codeChallenge);
  await signIn(provider, { redirectTo: callbackUrl.toString() });
  return NextResponse.json({ error: "OAuth redirect was not started." }, { status: 500 });
}
