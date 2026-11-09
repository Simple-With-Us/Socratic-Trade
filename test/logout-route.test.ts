import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /logout", () => {
  it("ignores forwarded host and uses request origin for local development", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    const { GET } = await import("../app/logout/route");

    const response = await GET(
      new NextRequest("http://localhost:4000/logout", {
        headers: { "x-forwarded-host": "socratictrade.com" }
      })
    );
    const location = response.headers.get("location");

    expect(location).toBe("http://localhost:4000/login");
  });

  it("uses the configured public site URL for app logout when forwarded headers are absent", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://socratictrade.com");
    const { GET } = await import("../app/logout/route");

    const response = await GET(new NextRequest("http://localhost:4000/logout"));

    expect(response.headers.get("location")).toBe("https://socratictrade.com/login");
  });
});
