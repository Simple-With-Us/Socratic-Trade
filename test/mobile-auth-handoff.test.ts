import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { consumeMobileAuthHandoff, createMobileAuthHandoff } from "../src/lib/mobile-auth-handoff";

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

describe("mobile OAuth handoff", () => {
  it("exchanges a verifier-bound opaque code once without exposing the session token", () => {
    const verifier = "v".repeat(43);
    const code = createMobileAuthHandoff({ sessionToken: "session-secret", codeChallenge: challenge(verifier) });

    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(code).not.toContain("session-secret");
    expect(consumeMobileAuthHandoff({ code: code!, codeVerifier: verifier })).toEqual({
      sessionToken: "session-secret",
      cookieName: "authjs.session-token",
    });
    expect(consumeMobileAuthHandoff({ code: code!, codeVerifier: verifier })).toBeUndefined();
  });

  it("rejects a code when a different app lacks the verifier", () => {
    const code = createMobileAuthHandoff({ sessionToken: "session-secret", codeChallenge: challenge("a".repeat(43)) });

    expect(consumeMobileAuthHandoff({ code: code!, codeVerifier: "b".repeat(43) })).toBeUndefined();
  });

  it("refuses an unknown cookie name rather than storing an unsaltable token", () => {
    expect(
      createMobileAuthHandoff({
        sessionToken: "session-secret",
        cookieName: "csrf.session-token-hint",
        codeChallenge: challenge("a".repeat(43)),
      }),
    ).toBeUndefined();
  });
});
