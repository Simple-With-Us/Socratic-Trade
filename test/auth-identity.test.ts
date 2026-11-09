import { afterEach, describe, expect, it, vi } from "vitest";
import { isEmailAllowed, isPrimaryEmail, userIdForEmail } from "../src/lib/auth/identity";

describe("auth identity — multi-user keystone (Q3)", () => {
  it("primary email keeps the legacy 'local' id (no data migration); others get isolated stable ids", () => {
    expect(userIdForEmail("mail@jays.services")).toBe("local");
    expect(userIdForEmail("  MAIL@Jays.Services ")).toBe("local"); // normalized

    const a = userIdForEmail("alice@example.com");
    const b = userIdForEmail("bob@example.com");
    expect(a).toMatch(/^u_[0-9a-f]{24}$/);
    expect(a).not.toBe("local");
    expect(a).not.toBe(b);
    expect(userIdForEmail("ALICE@example.com")).toBe(a); // deterministic + case-insensitive
  });

  it("same verified email from different Auth.js providers maps to the same app account", () => {
    const googleEmail = "Investor@Example.com";
    const githubEmail = " investor@example.com ";

    expect(userIdForEmail(googleEmail)).toBe(userIdForEmail(githubEmail));
  });

  it("invalid emails fall back to the dev user rather than minting a junk tenant", () => {
    expect(userIdForEmail("")).toBe("local");
    expect(userIdForEmail("not-an-email")).toBe("local");
  });

  it("allowlist: primary always allowed; with no ALLOWED_EMAILS set, non-primary users fail closed", () => {
    expect(isPrimaryEmail("mail@jays.services")).toBe(true);
    expect(isEmailAllowed("mail@jays.services")).toBe(true);
    expect(isEmailAllowed("anyone@example.com")).toBe(false);
    expect(isEmailAllowed("")).toBe(false);
  });
});

describe("auth identity — primary email aliases", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("every PRIMARY_USER_EMAIL_ALIASES address shares the one 'local' account with the primary", () => {
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@gmail.example");
    vi.stubEnv("PRIMARY_USER_EMAIL_ALIASES", "owner@custom.example, owner@work.example");

    // All three map to the single primary dataset.
    expect(userIdForEmail("owner@gmail.example")).toBe("local");
    expect(userIdForEmail("OWNER@Custom.Example")).toBe("local"); // normalized
    expect(userIdForEmail("owner@work.example")).toBe("local");

    // All three are recognized as primary and allowed.
    for (const e of ["owner@gmail.example", "owner@custom.example", "owner@work.example"]) {
      expect(isPrimaryEmail(e)).toBe(true);
      expect(isEmailAllowed(e)).toBe(true);
    }

    // A non-listed address is a separate isolated tenant, not the primary.
    const stranger = userIdForEmail("stranger@example.com");
    expect(stranger).toMatch(/^u_[0-9a-f]{24}$/);
    expect(stranger).not.toBe("local");
    expect(isPrimaryEmail("stranger@example.com")).toBe(false);
  });

  it("aliases are still gated by ALLOWED_EMAILS for non-primary addresses", () => {
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@gmail.example");
    vi.stubEnv("PRIMARY_USER_EMAIL_ALIASES", "owner@custom.example");
    vi.stubEnv("ALLOWED_EMAILS", "teammate@example.com");

    // Primary + aliases bypass ALLOWED_EMAILS entirely.
    expect(isEmailAllowed("owner@gmail.example")).toBe(true);
    expect(isEmailAllowed("owner@custom.example")).toBe(true);
    // Explicitly-allowed teammate is in; everyone else is out once ALLOWED_EMAILS is non-empty.
    expect(isEmailAllowed("teammate@example.com")).toBe(true);
    expect(isEmailAllowed("stranger@example.com")).toBe(false);
  });
});
