import { NextResponse } from "next/server";
import { resolveRequestUserOrResponse } from "@/lib/request-user";
import { revokeAllSessionsForEmail } from "@/lib/auth/session-sign-out";
import { appendClearAllSessionCookies } from "@/lib/auth/session-cookie-names";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST — revoke every server session for the signed-in user (sign out everywhere). */
export async function POST(request: Request) {
  let email: string | undefined;
  try {
    const userOrDenied = resolveRequestUserOrResponse(request);
    if (userOrDenied instanceof Response) return userOrDenied;
    email = userOrDenied.email;
  } catch (err) {
    if (err instanceof Error && /revoked|expired/i.test(err.message)) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }
    throw err;
  }
  if (!email) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const revoked = revokeAllSessionsForEmail(email);
  const response = NextResponse.json({ ok: true, revoked });
  appendClearAllSessionCookies(response);
  return response;
}
