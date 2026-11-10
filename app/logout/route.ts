import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { resolvePublicAppOrigin } from "@/lib/public-origin";
import { revokeSessionFromCookieHeader } from "@/lib/auth/session-sign-out";
import { appendClearAllSessionCookies } from "@/lib/auth/session-cookie-names";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const authSecret = process.env.AUTH_SECRET;
  if (authSecret) {
    await revokeSessionFromCookieHeader(request.headers.get("cookie"), authSecret);
  }

  const appOrigin = resolvePublicAppOrigin(request);
  const returnTo = new URL("/login", appOrigin).toString();
  const response = NextResponse.redirect(returnTo);

  appendClearAllSessionCookies(response);
  return response;
}
