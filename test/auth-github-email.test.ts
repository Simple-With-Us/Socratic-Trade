import { afterEach, describe, expect, it, vi } from "vitest";
import { selectVerifiedGitHubEmail } from "../src/lib/auth/github-email";

describe("GitHub Auth.js email selection", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("prefers a verified app-allowed GitHub email before GitHub's primary email", () => {
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("PRIMARY_USER_EMAIL_ALIASES", "owner@custom.example");
    vi.stubEnv("ALLOWED_EMAILS", "");

    expect(
      selectVerifiedGitHubEmail(
        [
          { email: "primary@example.com", primary: true, verified: true },
          { email: "OWNER@Custom.Example", primary: false, verified: true }
        ],
        "primary@example.com"
      )
    ).toBe("owner@custom.example");
  });

  it("uses explicit ALLOWED_EMAILS before falling back to GitHub's primary email", () => {
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("PRIMARY_USER_EMAIL_ALIASES", "");
    vi.stubEnv("ALLOWED_EMAILS", "teammate@example.com");

    expect(
      selectVerifiedGitHubEmail([
        { email: "primary@example.com", primary: true, verified: true },
        { email: "teammate@example.com", primary: false, verified: true }
      ])
    ).toBe("teammate@example.com");
  });

  it("falls back to GitHub primary when no verified email is app-allowed", () => {
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("PRIMARY_USER_EMAIL_ALIASES", "");
    vi.stubEnv("ALLOWED_EMAILS", "");

    expect(
      selectVerifiedGitHubEmail([
        { email: "other@example.com", primary: false, verified: true },
        { email: "primary@example.com", primary: true, verified: true }
      ])
    ).toBe("primary@example.com");
  });
});
