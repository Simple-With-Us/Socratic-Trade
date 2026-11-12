import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { absoluteExpUnixSeconds, createAuthServerSession } from "../src/lib/db-auth-sessions";
import { userIdForEmail } from "../src/lib/auth/identity";
import {
  SESSION_JWT_ABS_EXP_CLAIM,
  SESSION_JWT_SID_CLAIM,
  SESSION_JWT_SRV_TOUCH_CLAIM,
} from "../src/lib/auth/session-policy";
import { encodeSessionToken } from "../src/lib/auth/session-token";

const secret = "test-auth-secret-32-chars-minimum!!";
const salt = "authjs.session-token";
const email = "ios-web-oauth@example.com";

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

const cookieStore = vi.hoisted(() => ({
  cookies: [] as Array<{ name: string; value: string }>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => cookieStore.cookies,
    get: (name: string) => cookieStore.cookies.find((c) => c.name === name),
  }),
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-mobile-redirect-${randomUUID()}.db`)}`;
  process.env.AUTH_SECRET = secret;
});

beforeEach(() => {
  cookieStore.cookies = [];
});

describe("GET /api/mobile/auth-redirect", () => {
  it("succeeds for shipped iOS with a signed-in cookie and no handoff_nonce", async () => {
    const record = createAuthServerSession(userIdForEmail(email));
    const now = Math.floor(Date.now() / 1000);
    const sessionToken = await encodeSessionToken({
      token: {
        email,
        [SESSION_JWT_SID_CLAIM]: record.id,
        [SESSION_JWT_ABS_EXP_CLAIM]: absoluteExpUnixSeconds(record.absoluteExpiresAt),
        [SESSION_JWT_SRV_TOUCH_CLAIM]: now,
      },
      secret,
      salt,
    });
    cookieStore.cookies = [{ name: salt, value: sessionToken }];
    const verifier = "a".repeat(43);
    const codeChallenge = challenge(verifier);
    const { GET } = await import("../app/api/mobile/auth-redirect/route");
    const res = await GET(
      new Request(
        `https://socratictrade.com/api/mobile/auth-redirect?code_challenge=${codeChallenge}`,
      ),
    );
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("socratictrade://auth")).toBe(true);
    expect(new URL(location).searchParams.get("code")).toBeTruthy();
    expect(new URL(location).searchParams.get("error")).toBeNull();
  });
});
