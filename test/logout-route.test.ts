import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /logout", () => {
  it("routes logout back to the public app login when the app sees localhost internally", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    const { GET } = await import("../app/logout/route");

    const response = await GET(
      new NextRequest("http://localhost:4000/logout", {
        headers: { "x-forwarded-host": "socratictrade.com" }
      })
    );
    const location = response.headers.get("location");

    expect(location).toBe("https://socratictrade.com/login");
  });

  it("uses the configured public site URL for app logout when forwarded headers are absent", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://socratictrade.com");
    const { GET } = await import("../app/logout/route");

    const response = await GET(new NextRequest("http://localhost:4000/logout"));

    expect(response.headers.get("location")).toBe("https://socratictrade.com/login");
  });
});
