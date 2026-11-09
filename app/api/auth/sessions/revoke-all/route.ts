import { NextResponse } from "next/server";
import { resolveRequestUser } from "@/lib/request-user";
import { revokeAllSessionsForEmail } from "@/lib/auth/session-sign-out";
import { currentAuthjsSessionCookieName } from "@/lib/auth/session-cookie-names";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST — revoke every server session for the signed-in user (sign out everywhere). */
export async function POST(request: Request) {
  const { email } = resolveRequestUser(request);
  if (!email) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const revoked = revokeAllSessionsForEmail(email);
  const response = NextResponse.json({ ok: true, revoked });
  const cookieName = currentAuthjsSessionCookieName();
  response.cookies.delete(cookieName);
  for (let i = 0; i < 8; i += 1) response.cookies.delete(`${cookieName}.${i}`);
  return response;
}
