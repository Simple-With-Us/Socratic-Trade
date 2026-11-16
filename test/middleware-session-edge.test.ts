import { describe, expect, it } from "vitest";
import { absoluteExpUnixSeconds, createAuthServerSession } from "../src/lib/db-auth-sessions";
import { userIdForEmail } from "../src/lib/auth/identity";
import {
  SESSION_JWT_ABS_EXP_CLAIM,
  SESSION_JWT_SID_CLAIM,
  SESSION_JWT_SRV_TOUCH_CLAIM,
} from "../src/lib/auth/session-policy";
import { getSessionIdentity } from "../src/lib/auth/session-edge";
import { encodeSessionToken } from "../src/lib/auth/session-token";

const secret = "middleware-edge-test-secret-32-chars!!";
const salt = "authjs.session-token";

function cookieHeader(token: string): string {
  return `${salt}=${token}`;
}

describe("middleware session edge (getSessionIdentity)", () => {
  it("accepts legacy JWT cookies hours after iat (exp only)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await encodeSessionToken({
      token: {
        email: "legacy-edge@example.com",
        exp: now + 3600,
        iat: now - 6 * 3600,
      },
      secret,
      salt,
    });
    const identity = await getSessionIdentity(cookieHeader(token), secret);
    expect(identity?.email).toBe("legacy-edge@example.com");
  });

  it("accepts sid JWT cookies older than five minutes when absExp is valid", async () => {
    const record = createAuthServerSession(userIdForEmail("sid-edge@example.com"));
    const now = Math.floor(Date.now() / 1000);
    const token = await encodeSessionToken({
      token: {
        email: "sid-edge@example.com",
        [SESSION_JWT_SID_CLAIM]: record.id,
        [SESSION_JWT_ABS_EXP_CLAIM]: absoluteExpUnixSeconds(record.absoluteExpiresAt),
        [SESSION_JWT_SRV_TOUCH_CLAIM]: now - 3600,
      },
      secret,
      salt,
    });
    const identity = await getSessionIdentity(cookieHeader(token), secret);
    expect(identity?.email).toBe("sid-edge@example.com");
    expect(identity?.sessionId).toBe(record.id);
  });
});
