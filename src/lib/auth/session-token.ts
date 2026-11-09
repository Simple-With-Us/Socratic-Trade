import "server-only";
import type { JWTPayload } from "jose";
import { isAuthServerSessionActive } from "../db-auth-sessions";
import {
  SESSION_JWT_ABS_EXP_CLAIM,
  SESSION_JWT_SID_CLAIM,
} from "./session-policy";
import { decodeSessionJwtCrypto, encodeSessionJwtCrypto } from "./session-jwt-crypto";

type SecretInput = string | string[];

function legacyPayloadIsValid(payload: JWTPayload, nowSeconds: number): boolean {
  const absExp = payload[SESSION_JWT_ABS_EXP_CLAIM];
  if (typeof absExp === "number" && Number.isFinite(absExp) && absExp <= nowSeconds) return false;
  return true;
}

async function assertServerSessionActive(payload: JWTPayload): Promise<boolean> {
  const sid = payload[SESSION_JWT_SID_CLAIM];
  if (typeof sid !== "string" || !sid) {
    return legacyPayloadIsValid(payload, Math.floor(Date.now() / 1000));
  }
  return isAuthServerSessionActive(sid);
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
