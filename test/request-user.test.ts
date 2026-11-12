import { describe, expect, it } from "vitest";
import { DEFAULT_REQUEST_USER_ID, resolveRequestUserId } from "../src/lib/request-user";
import { userIdForEmail } from "../src/lib/auth/identity";

// Identity is established by middleware (verified Auth.js/Google session) and forwarded as the trusted
// `x-authenticated-user-email` header. resolveRequestUserId must trust ONLY that header — never the old
// spoofable `x-user-id` / `?userId` / body hints (the closed IDOR vectors).
describe("resolveRequestUserId (post-auth)", () => {
  it("maps the trusted authenticated-email header to a stable userId", () => {
    const req = new Request("http://localhost/api/dashboard", {
      headers: { "x-authenticated-user-email": "alice@example.com" }
    });
    expect(resolveRequestUserId(req)).toBe(userIdForEmail("alice@example.com"));
  });

  it("IGNORES client-supplied x-user-id, ?userId, and body userId (no IDOR)", () => {
    const req = new Request("http://localhost/api/keys?userId=victim", {
      headers: { "x-user-id": "victim", "x-authenticated-user-email": "alice@example.com" }
    });
    expect(resolveRequestUserId(req, { userId: "victim" })).toBe(userIdForEmail("alice@example.com"));
    expect(resolveRequestUserId(req, { userId: "victim" })).not.toBe("victim");
  });

  it("falls back to the dev user (NOT a client hint) when no verified identity is present", () => {
    const req = new Request("http://localhost/api/keys?userId=victim", { headers: { "x-user-id": "victim" } });
    expect(resolveRequestUserId(req, { userId: "victim" })).toBe(DEFAULT_REQUEST_USER_ID);
  });
});

describe("authErrorResponse status mapping (ST-4610)", () => {
  it("maps tagged session/account-generation errors to their client status and rethrows the rest", async () => {
    const { authErrorResponse } = await import("../src/lib/request-user");
    const stale = authErrorResponse(Object.assign(new Error("This session predates account deletion; sign in again."), { status: 401 }));
    expect(stale?.status).toBe(401);
    const generation = authErrorResponse(Object.assign(new Error("Authenticated account generation is stale."), { status: 409 }));
    expect(generation?.status).toBe(409);
    expect(authErrorResponse(new Error("Session revoked or expired."))?.status).toBe(401);
    expect(authErrorResponse(new Error("Account identity generation changed during sign-in."))).toBeNull();
    expect(authErrorResponse(Object.assign(new Error("db down"), { status: 500 }))).toBeNull();
  });
});
