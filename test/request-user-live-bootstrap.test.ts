import { afterEach, describe, expect, it, vi } from "vitest";

describe("resolveRequestUser — live bootstrap fail-closed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("refuses to resolve anonymous identity when DB_BOOTSTRAP=live", async () => {
    vi.stubEnv("DB_BOOTSTRAP", "live");
    const { resolveRequestUser, AUTHENTICATED_EMAIL_HEADER } = await import("../src/lib/request-user");
    const request = new Request("https://example.test/api/dashboard");
    expect(request.headers.get(AUTHENTICATED_EMAIL_HEADER)).toBeNull();
    expect(() => resolveRequestUser(request)).toThrow(/identity is required in live bootstrap/i);
  });

  it("refuses the dev local-fallback provenance when DB_BOOTSTRAP=live", async () => {
    vi.stubEnv("DB_BOOTSTRAP", "live");
    const { resolveRequestUser, AUTHENTICATED_EMAIL_HEADER } = await import("../src/lib/request-user");
    const { AUTHENTICATED_IDENTITY_SOURCE_HEADER, AUTHENTICATED_IDENTITY_SOURCES } = await import(
      "../src/lib/auth/strip-identity"
    );
    const request = new Request("https://example.test/api/dashboard", {
      headers: {
        [AUTHENTICATED_EMAIL_HEADER]: "owner@example.com",
        [AUTHENTICATED_IDENTITY_SOURCE_HEADER]: AUTHENTICATED_IDENTITY_SOURCES.localFallback
      }
    });
    expect(() => resolveRequestUser(request)).toThrow(/identity is required in live bootstrap/i);
  });

  it("still resolves verified identities in live bootstrap", async () => {
    vi.stubEnv("DB_BOOTSTRAP", "live");
    const { resolveRequestUser, AUTHENTICATED_EMAIL_HEADER } = await import("../src/lib/request-user");
    const { AUTHENTICATED_IDENTITY_SOURCE_HEADER, AUTHENTICATED_IDENTITY_SOURCES } = await import(
      "../src/lib/auth/strip-identity"
    );
    const request = new Request("https://example.test/api/dashboard", {
      headers: {
        [AUTHENTICATED_EMAIL_HEADER]: "owner@example.com",
        [AUTHENTICATED_IDENTITY_SOURCE_HEADER]: AUTHENTICATED_IDENTITY_SOURCES.authJsSession
      }
    });
    expect(resolveRequestUser(request).email).toBe("owner@example.com");
  });

  it("keeps the dev fallback path when DB_BOOTSTRAP is unset", async () => {
    vi.stubEnv("PRIMARY_USER_EMAIL", "devowner@example.com");
    const { resolveRequestUserFromEmail } = await import("../src/lib/request-user");
    expect(resolveRequestUserFromEmail(null).userId).toBe("local");
  });
});
