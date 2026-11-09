import type { JWTPayload } from "jose";
import { SignJWT } from "jose/jwt/sign";
import { jwtVerify } from "jose/jwt/verify";

const encoder = new TextEncoder();
const DEFAULT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

type SecretInput = string | string[];

function secrets(value: SecretInput): string[] {
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

function keyFor(secret: string, salt: string): Uint8Array {
  return encoder.encode(`${secret}:${salt}`);
}

export async function encodeSessionToken(params: {
  token?: JWTPayload;
  secret: SecretInput;
  maxAge?: number;
  salt: string;
}): Promise<string> {
  const secret = secrets(params.secret)[0];
  if (!secret) throw new Error("AUTH_SECRET is required to encode a session token.");
  return await new SignJWT(params.token ?? {})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (params.maxAge ?? DEFAULT_MAX_AGE_SECONDS))
    .sign(keyFor(secret, params.salt));
}

export async function decodeSessionToken(params: {
  token?: string;
  secret: SecretInput;
  salt: string;
}): Promise<JWTPayload | null> {
  if (!params.token) return null;
  for (const secret of secrets(params.secret)) {
    try {
      const { payload } = await jwtVerify(params.token, keyFor(secret, params.salt), {
        algorithms: ["HS256"],
        clockTolerance: 15
      });
      return payload;
    } catch {
      // Try the next configured secret, matching Auth.js secret rotation behavior.
    }
  }
  return null;
}
