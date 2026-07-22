import { NextResponse } from "next/server";
import { consumeMobileAuthExchange } from "@/lib/mobile-auth-exchange";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const input = body as { code?: unknown; state?: unknown; codeVerifier?: unknown };
  if (typeof input.code !== "string" || typeof input.state !== "string" || typeof input.codeVerifier !== "string") {
    return NextResponse.json({ error: "Invalid mobile auth exchange." }, { status: 400 });
  }

  const sessionToken = consumeMobileAuthExchange({
    code: input.code,
    state: input.state,
    codeVerifier: input.codeVerifier
  });
  if (!sessionToken) {
    return NextResponse.json({ error: "Mobile auth exchange expired or invalid." }, { status: 401 });
  }

  const cookieName = process.env.NODE_ENV === "production" ? "__Secure-authjs.session-token" : "authjs.session-token";
  const response = NextResponse.json({ success: true });
  response.cookies.set(cookieName, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60
  });
  response.headers.set("cache-control", "no-store");
  return response;
}
