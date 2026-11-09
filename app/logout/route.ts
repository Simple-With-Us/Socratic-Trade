import { NextRequest, NextResponse } from "next/server";
import { resolvePublicAppOrigin } from "@/lib/public-origin";

export const dynamic = "force-dynamic";

const AUTHJS_COOKIE_NAMES = ["__Secure-authjs.session-token", "authjs.session-token"] as const;

export async function GET(request: NextRequest) {
  const appOrigin = resolvePublicAppOrigin(request);
  const returnTo = new URL("/login", appOrigin).toString();
  const response = NextResponse.redirect(returnTo);

  for (const name of AUTHJS_COOKIE_NAMES) {
    response.cookies.delete(name);
    for (let i = 0; i < 8; i += 1) response.cookies.delete(`${name}.${i}`);
  }

  return response;
}
