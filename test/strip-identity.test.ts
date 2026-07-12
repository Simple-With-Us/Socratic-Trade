import { describe, expect, it } from "vitest";
import { CLIENT_IDENTITY_HEADERS, stripClientIdentityHeaders } from "../src/lib/auth/strip-identity";

describe("stripClientIdentityHeaders", () => {
  it("removes client-supplied identity headers so they can't be spoofed in", () => {
    const headers = new Headers({
      "x-authenticated-user-email": "victim@example.com",
      "x-user-id": "victim",
      "content-type": "application/json",
      authorization: "Bearer keep-me"
    });

    stripClientIdentityHeaders(headers);

    expect(headers.get("x-authenticated-user-email")).toBeNull();
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

  it("covers exactly the two trusted identity headers", () => {
    expect([...CLIENT_IDENTITY_HEADERS]).toEqual(["x-authenticated-user-email", "x-user-id"]);
  });
});
