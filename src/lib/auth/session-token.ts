import "server-only";
import type { JWTPayload } from "jose";
import { isAuthServerSessionActive } from "../db-auth-sessions";
import { SESSION_JWT_SID_CLAIM } from "./session-policy";
import { decodeSessionJwtCrypto, encodeSessionJwtCrypto } from "./session-jwt-crypto";

async function legacyPayloadWithinExp(payload: JWTPayload, nowSeconds: number): Promise<boolean> {
  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= nowSeconds) return false;
  const email = payload.email;
  return typeof email === "string" && email.includes("@");
}

async function assertServerSessionActive(payload: JWTPayload): Promise<boolean> {
  const sid = payload[SESSION_JWT_SID_CLAIM];
  if (typeof sid === "string" && sid) {
    return isAuthServerSessionActive(sid);
  }
  return legacyPayloadWithinExp(payload, Math.floor(Date.now() / 1000));
}

export async function encodeSessionToken(params: Parameters<typeof encodeSessionJwtCrypto>[0]): Promise<string> {
  return encodeSessionJwtCrypto(params);
}

export async function decodeSessionToken(params: Parameters<typeof decodeSessionJwtCrypto>[0]): Promise<JWTPayload | null> {
  const payload = await decodeSessionJwtCrypto(params);
  if (!payload) return null;
  if (!(await assertServerSessionActive(payload))) return null;
  return payload;
}
