import { describe, expect, it } from "vitest";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_SESSION_ISSUED_AT_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES,
  CLIENT_IDENTITY_HEADERS,
  isVerifiedIdentitySource,
  stripClientIdentityHeaders
} from "../src/lib/auth/strip-identity";

describe("stripClientIdentityHeaders", () => {
  it("removes client-supplied identity headers so they can't be spoofed in", () => {
    const headers = new Headers({
      "x-authenticated-user-email": "victim@example.com",
      [AUTHENTICATED_IDENTITY_SOURCE_HEADER]: AUTHENTICATED_IDENTITY_SOURCES.authJsSession,
      [AUTHENTICATED_SESSION_ISSUED_AT_HEADER]: "2099-01-01T00:00:00.000Z",
      "x-user-id": "victim",
      "content-type": "application/json",
      authorization: "Bearer keep-me"
    });

    stripClientIdentityHeaders(headers);

    expect(headers.get("x-authenticated-user-email")).toBeNull();
    expect(headers.get(AUTHENTICATED_IDENTITY_SOURCE_HEADER)).toBeNull();
    expect(headers.get(AUTHENTICATED_SESSION_ISSUED_AT_HEADER)).toBeNull();
    expect(headers.get("x-user-id")).toBeNull();
    // Non-identity headers are untouched.
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer keep-me");
  });

  it("is a no-op when no identity headers are present, and returns the same Headers for chaining", () => {
    const headers = new Headers({ "x-real-ip": "1.2.3.4" });
    const returned = stripClientIdentityHeaders(headers);
    expect(returned).toBe(headers);
    expect(returned.get("x-real-ip")).toBe("1.2.3.4");
  });

  it("covers every trusted identity header", () => {
    expect([...CLIENT_IDENTITY_HEADERS]).toEqual([
      "x-authenticated-user-email",
      AUTHENTICATED_IDENTITY_SOURCE_HEADER,
      AUTHENTICATED_SESSION_ISSUED_AT_HEADER,
      "x-user-id"
    ]);
  });

  it("classifies only upstream-verified provenance as verified", () => {
    expect(isVerifiedIdentitySource(AUTHENTICATED_IDENTITY_SOURCES.cloudflareAccess)).toBe(true);
    expect(isVerifiedIdentitySource(AUTHENTICATED_IDENTITY_SOURCES.authJsSession)).toBe(true);
    expect(isVerifiedIdentitySource(AUTHENTICATED_IDENTITY_SOURCES.localFallback)).toBe(false);
    expect(isVerifiedIdentitySource(null)).toBe(false);
  });
});
