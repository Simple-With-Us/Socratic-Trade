import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_EDGE_TRUST_SEC,
  SESSION_JWT_ABS_EXP_CLAIM,
  SESSION_JWT_SID_CLAIM,
  SESSION_JWT_SRV_TOUCH_CLAIM,
} from "../src/lib/auth/session-policy";
import { edgeSessionTrustValid } from "../src/lib/auth/session-edge";
import {
  LEGACY_MOBILE_HANDOFF_NONCE,
  LEGACY_MOBILE_SESSION_ID,
  MOBILE_SESSION_HARDENING_HEADER,
  mobileAppleSignInIsStrict,
  mobileOAuthHandoffIsStrict,
} from "../src/lib/auth/mobile-session-hardening";
import { resolveRequestUser } from "../src/lib/request-user";
import { AUTHENTICATED_SESSION_SID_HEADER } from "../src/lib/auth/strip-identity";
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
    const now = Math.floor(Date.now() / 1000);
    const token = await encodeSessionToken({
      token: {
        email: "a@example.com",
        [SESSION_JWT_SID_CLAIM]: record.id,
        [SESSION_JWT_ABS_EXP_CLAIM]: now + 3600,
        [SESSION_JWT_SRV_TOUCH_CLAIM]: now,
      },
      secret,
      salt,
    });
    expect(await decodeSessionToken({ token, secret, salt })).toBeTruthy();
    revokeAuthServerSession(record.id);
    expect(await decodeSessionToken({ token, secret, salt })).toBeNull();
  });

  it("migrates legacy JWTs without sid into auth_sessions on Node decode", async () => {
    const token = await encodeSessionToken({
      token: { email: "legacy-migrate@example.com" },
      secret,
      salt,
      maxAge: 3600,
    });
    const payload = await decodeSessionToken({ token, secret, salt });
    expect(payload?.[SESSION_JWT_SID_CLAIM]).toBeTruthy();
    expect(payload?.[SESSION_JWT_ABS_EXP_CLAIM]).toBeTruthy();
    expect(payload?.[SESSION_JWT_SRV_TOUCH_CLAIM]).toBeTruthy();
  });

  it("rejects edge-trusted cookies outside the server-touch window", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      edgeSessionTrustValid(
        {
          [SESSION_JWT_SID_CLAIM]: "sid",
          [SESSION_JWT_ABS_EXP_CLAIM]: now + 3600,
          [SESSION_JWT_SRV_TOUCH_CLAIM]: now - SESSION_EDGE_TRUST_SEC - 1,
        },
        now,
      ),
    ).toBe(false);
  });

  it("resolveRequestUser rejects revoked authjs session sid from middleware", () => {
    const record = createAuthServerSession(userIdForEmail("revoked-header@example.com"));
    revokeAuthServerSession(record.id);
    expect(() =>
      resolveRequestUser(
        new Request("https://socratictrade.com/api/dashboard", {
          headers: {
            "x-authenticated-user-email": "revoked-header@example.com",
            "x-authenticated-identity-source": "authjs-session",
            [AUTHENTICATED_SESSION_SID_HEADER]: record.id,
          },
        }),
      ),
    ).toThrow(/revoked/i);
  });

  it("honors AUTH_SECRET rotation when the session row is still active", async () => {
    const record = createAuthServerSession("user-b");
    const now = Math.floor(Date.now() / 1000);
    const oldSecret = "old-rotation-secret-32-characters!!";
    const newSecret = "new-rotation-secret-32-characters!!";
    const token = await encodeSessionToken({
      token: {
        [SESSION_JWT_SID_CLAIM]: record.id,
        [SESSION_JWT_ABS_EXP_CLAIM]: now + 3600,
        [SESSION_JWT_SRV_TOUCH_CLAIM]: now,
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

describe("mobile session hardening compat", () => {
  it("treats missing nonce as legacy unless the client declares hardening", () => {
    const base = new Request("https://socratictrade.com/api/mobile/auth-redirect");
    expect(mobileOAuthHandoffIsStrict(base, "")).toBe(false);
    expect(
      mobileOAuthHandoffIsStrict(
        new Request("https://socratictrade.com", {
          headers: { [MOBILE_SESSION_HARDENING_HEADER]: "1" },
        }),
        "",
      ),
    ).toBe(true);
    expect(mobileAppleSignInIsStrict(base, "")).toBe(false);
    expect(mobileAppleSignInIsStrict(base, "server-nonce")).toBe(true);
  });

  it("creates legacy-compat handoff rows", () => {
    const code = createMobileAuthHandoff({
      sessionToken: "jwt",
      codeChallenge: challenge("z".repeat(43)),
      handoffNonce: LEGACY_MOBILE_HANDOFF_NONCE,
      sessionId: LEGACY_MOBILE_SESSION_ID,
    });
    expect(code).toBeTruthy();
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
