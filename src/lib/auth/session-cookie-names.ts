import type { JWTPayload } from "jose";
import { decodeSessionToken, encodeSessionToken } from "./session-token";

/** Auth.js v5 session cookie names, in preference order. */
export const AUTHJS_SESSION_COOKIE_NAMES = [
  "__Secure-authjs.session-token",
  "authjs.session-token",
] as const;

/** NextAuth v4 names that may still be on a browser after the v5 rename. */
export const LEGACY_NEXTAUTH_SESSION_COOKIE_NAMES = [
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
] as const;

export const KNOWN_SESSION_COOKIE_NAMES = [
  ...AUTHJS_SESSION_COOKIE_NAMES,
  ...LEGACY_NEXTAUTH_SESSION_COOKIE_NAMES,
] as const;

export type KnownSessionCookieName = (typeof KNOWN_SESSION_COOKIE_NAMES)[number];

export function currentAuthjsSessionCookieName(
  env: NodeJS.ProcessEnv = process.env,
): KnownSessionCookieName {
  return env.NODE_ENV === "production"
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";
}

export function isKnownSessionCookieName(name: string): name is KnownSessionCookieName {
  return (KNOWN_SESSION_COOKIE_NAMES as readonly string[]).includes(name);
}

/**
 * First matching Auth.js / NextAuth session cookie.  Does not accept an
 * arbitrary name that merely contains "session-token".
 */
export function pickSessionCookie(
  cookies: ReadonlyArray<{ name: string; value: string }>,
): { name: KnownSessionCookieName; value: string } | undefined {
  for (const name of KNOWN_SESSION_COOKIE_NAMES) {
    const found = cookies.find((cookie) => cookie.name === name && cookie.value);
    if (found) return { name, value: found.value };
  }
  return undefined;
}

/**
 * Session JWTs are salted with AUTH_SECRET plus the cookie name.  A token issued
 * under `next-auth.session-token` cannot validate after being rewritten as
 * `authjs.session-token`.  Decode with the source salt and re-encode under the
 * current cookie name; same-name cookies pass through.
 */
export async function sessionTokenForCurrentCookie(input: {
  sessionToken: string;
  cookieName: string;
  secret: string | undefined;
  env?: NodeJS.ProcessEnv;
}): Promise<{ cookieName: KnownSessionCookieName; token: string; maxAge?: number } | undefined> {
  const currentName = currentAuthjsSessionCookieName(input.env);
  if (!input.sessionToken) return undefined;
  if (input.cookieName === currentName) {
    return { cookieName: currentName, token: input.sessionToken };
  }
  if (!isKnownSessionCookieName(input.cookieName)) return undefined;
  if (!input.secret) return undefined;
  const payload = await decodeSessionToken({
    token: input.sessionToken,
    secret: input.secret,
    salt: input.cookieName,
  });
  if (!payload) return undefined;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number") return undefined;
  const maxAge = Math.floor(payload.exp - nowSeconds);
  if (maxAge <= 0) return undefined;
  const { iat: _iat, exp: _exp, nbf: _nbf, ...claims } = payload;
  const token = await encodeSessionToken({
    token: claims as JWTPayload,
    secret: input.secret,
    salt: currentName,
    maxAge,
  });
  return { cookieName: currentName, token, maxAge };
}
