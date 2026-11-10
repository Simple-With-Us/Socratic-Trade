import "server-only";
import { decodeSessionToken } from "./session-token";
import { pickSessionCookie } from "./session-cookie-names";
import { revokeAllAuthServerSessionsForUser, revokeAuthServerSession } from "../db-auth-sessions";
import { userIdForEmail } from "./identity";

export async function revokeSessionFromCookieHeader(
  cookieHeader: string | null,
  secret: string
): Promise<string | undefined> {
  if (!cookieHeader || !secret) return undefined;
  const parts = cookieHeader.split(";").map((p) => p.trim());
  const cookies = parts.flatMap((part) => {
    const idx = part.indexOf("=");
    if (idx < 0) return [];
    return [{ name: part.slice(0, idx), value: part.slice(idx + 1) }];
  });
  const sessionCookie = pickSessionCookie(cookies);
  if (!sessionCookie) return undefined;
  const payload = await decodeSessionToken({
    token: sessionCookie.value,
    secret,
    salt: sessionCookie.name,
  });
  const sid = payload?.sid;
  if (typeof sid !== "string" || !sid) return undefined;
  revokeAuthServerSession(sid);
  return sid;
}

export function revokeAllSessionsForEmail(email: string): number {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return 0;
  return revokeAllAuthServerSessionsForUser(userIdForEmail(normalized));
}
