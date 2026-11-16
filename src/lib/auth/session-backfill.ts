import "server-only";
import type { JWTPayload } from "jose";
import type { JWT } from "next-auth/jwt";
import {
  absoluteExpUnixSeconds,
  createAuthServerSession,
} from "../db-auth-sessions";
import { userIdForEmail } from "./identity";
import {
  SESSION_JWT_ABS_EXP_CLAIM,
  SESSION_JWT_SID_CLAIM,
  SESSION_JWT_SRV_TOUCH_CLAIM,
} from "./session-policy";

function hasEmailClaim(payload: JWTPayload): payload is JWTPayload & { email: string } {
  return typeof payload.email === "string" && payload.email.includes("@");
}

/** Create a server session row and embed `sid` / `absExp` on a legacy JWT payload. */
export function backfillServerSessionClaims(
  token: JWT | JWTPayload,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const sid = token[SESSION_JWT_SID_CLAIM];
  if (typeof sid === "string" && sid) return false;
  if (!hasEmailClaim(token)) return false;
  const record = createAuthServerSession(userIdForEmail(token.email));
  token[SESSION_JWT_SID_CLAIM] = record.id;
  token[SESSION_JWT_ABS_EXP_CLAIM] = absoluteExpUnixSeconds(record.absoluteExpiresAt);
  token[SESSION_JWT_SRV_TOUCH_CLAIM] = nowSeconds;
  return true;
}
