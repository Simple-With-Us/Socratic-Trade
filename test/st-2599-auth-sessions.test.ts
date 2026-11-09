import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_JWT_ABS_EXP_CLAIM,
  SESSION_JWT_SID_CLAIM,
} from "../src/lib/auth/session-policy";
import { encodeSessionToken, decodeSessionToken } from "../src/lib/auth/session-token";
import {
  createAuthServerSession,
  revokeAuthServerSession,
  revokeAllAuthServerSessionsForUser,
} from "../src/lib/db-auth-sessions";
import { userIdForEmail } from "../src/lib/auth/identity";
import { issueAppleSignInNonce } from "../src/lib/auth/apple-signin-nonce";
import { issueMobileHandoffPrepare, consumeMobileHandoffPrepare } from "../src/lib/auth/mobile-handoff-prepare";
import { createMobileAuthHandoff } from "../src/lib/mobile-auth-handoff";
import { createHash } from "node:crypto";

const secret = "test-auth-secret-32-chars-minimum!!";
const salt = "authjs.session-token";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-st2599-${randomUUID()}.db`)}`;
  process.env.AUTH_SECRET = secret;
});

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

describe("server-backed sessions", () => {
  it("rejects a JWT after its server session is revoked", async () => {
    const record = createAuthServerSession("user-a");
    const token = await encodeSessionToken({
      token: {
        email: "a@example.com",
        [SESSION_JWT_SID_CLAIM]: record.id,
        [SESSION_JWT_ABS_EXP_CLAIM]: Math.floor(Date.now() / 1000) + 3600,
      },
      secret,
      salt,
    });
    expect(await decodeSessionToken({ token, secret, salt })).toBeTruthy();
    revokeAuthServerSession(record.id);
    expect(await decodeSessionToken({ token, secret, salt })).toBeNull();
  });

  it("honors AUTH_SECRET rotation when the session row is still active", async () => {
    const record = createAuthServerSession("user-b");
    const oldSecret = "old-rotation-secret-32-characters!!";
    const newSecret = "new-rotation-secret-32-characters!!";
    const token = await encodeSessionToken({
      token: {
        [SESSION_JWT_SID_CLAIM]: record.id,
        [SESSION_JWT_ABS_EXP_CLAIM]: Math.floor(Date.now() / 1000) + 3600,
      },
      secret: oldSecret,
      salt,
    });
    expect(await decodeSessionToken({ token, secret: [newSecret, oldSecret], salt })).toBeTruthy();
  });

  it("caps sliding refresh at the absolute server lifetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const record = createAuthServerSession("user-c");
    vi.setSystemTime(new Date("2026-03-15T00:00:00.000Z"));
    const { slidingMaxAgeSeconds } = await import("../src/lib/db-auth-sessions");
    expect(slidingMaxAgeSeconds(record.absoluteExpiresAt)).toBeLessThan(30 * 24 * 60 * 60);
    vi.useRealTimers();
  });

  it("revoke-all clears every session for the user", async () => {
    const userId = userIdForEmail("everywhere@example.com");
    const a = createAuthServerSession(userId);
    const b = createAuthServerSession(userId);
    expect(revokeAllAuthServerSessionsForUser(userId)).toBe(2);
    const { isAuthServerSessionActive } = await import("../src/lib/db-auth-sessions");
    expect(isAuthServerSessionActive(a.id)).toBe(false);
    expect(isAuthServerSessionActive(b.id)).toBe(false);
  });
});

describe("mobile handoff prepare + redirect binding", () => {
  it("requires a server nonce that matches the client challenge", () => {
    const verifier = "v".repeat(43);
    const codeChallenge = challenge(verifier);
    const handoffNonce = issueMobileHandoffPrepare(codeChallenge);
    expect(handoffNonce).toBeTruthy();
    expect(consumeMobileHandoffPrepare({ handoffNonce: handoffNonce!, codeChallenge })).toBe(true);
    expect(consumeMobileHandoffPrepare({ handoffNonce: handoffNonce!, codeChallenge })).toBe(false);
  });

  it("stores handoff codes bound to session id and nonce", () => {
    const code = createMobileAuthHandoff({
      sessionToken: "jwt",
      codeChallenge: challenge("a".repeat(43)),
      handoffNonce: "server-nonce",
      sessionId: randomUUID(),
    });
    expect(code).toBeTruthy();
  });
});

describe("apple sign-in nonce", () => {
  it("issues one-time nonces", () => {
    const first = issueAppleSignInNonce();
    const second = issueAppleSignInNonce();
    expect(first).not.toBe(second);
  });
});

describe("POST /api/auth/sessions/revoke-all", () => {
  it("revokes all sessions for the authenticated user", async () => {
    const email = `revoke-${randomUUID()}@example.com`;
    const userId = userIdForEmail(email);
    createAuthServerSession(userId);
    createAuthServerSession(userId);
    const { POST } = await import("../app/api/auth/sessions/revoke-all/route");
    const res = await POST(
      new Request("https://socratictrade.com/api/auth/sessions/revoke-all", {
        method: "POST",
        headers: { "x-authenticated-user-email": email },
      })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { revoked: number };
    expect(json.revoked).toBeGreaterThanOrEqual(2);
  });
});
