import { afterEach, describe, expect, it, vi } from "vitest";

describe("assertAuthSecretConfiguredInLiveBootstrap — fail-closed boot guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("throws when DB_BOOTSTRAP=live and no identity source is configured", async () => {
    const { assertAuthSecretConfiguredInLiveBootstrap } = await import("../src/lib/auth-secret-guard");
    expect(() =>
      assertAuthSecretConfiguredInLiveBootstrap({
        DB_BOOTSTRAP: "live"
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/AUTH_SECRET is missing in a live production boot/);
  });

  it("does not throw when DB_BOOTSTRAP=live and AUTH_SECRET is set", async () => {
    const { assertAuthSecretConfiguredInLiveBootstrap } = await import("../src/lib/auth-secret-guard");
    expect(() =>
      assertAuthSecretConfiguredInLiveBootstrap({
        DB_BOOTSTRAP: "live",
        AUTH_SECRET: "test-secret-at-least-32-bytes-long!!"
      } as unknown as NodeJS.ProcessEnv)
    ).not.toThrow();
  });

  it("does not throw when DB_BOOTSTRAP=live and Cloudflare Access trust is fully armed", async () => {
    const { assertAuthSecretConfiguredInLiveBootstrap } = await import("../src/lib/auth-secret-guard");
    expect(() =>
      assertAuthSecretConfiguredInLiveBootstrap({
        DB_BOOTSTRAP: "live",
        CF_ACCESS_TRUST_EMAIL_HEADER: "1",
        CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        CF_ACCESS_AUD: "test-audience"
      } as unknown as NodeJS.ProcessEnv)
    ).not.toThrow();
  });

  it("throws when DB_BOOTSTRAP=live and CF flag is on but team domain or audience is missing", async () => {
    const { assertAuthSecretConfiguredInLiveBootstrap } = await import("../src/lib/auth-secret-guard");
    expect(() =>
      assertAuthSecretConfiguredInLiveBootstrap({
        DB_BOOTSTRAP: "live",
        CF_ACCESS_TRUST_EMAIL_HEADER: "1",
        CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com"
      } as unknown as NodeJS.ProcessEnv)
    ).toThrow(/AUTH_SECRET is missing in a live production boot/);
  });

  it("never throws outside live bootstrap, even when AUTH_SECRET is missing", async () => {
    const { assertAuthSecretConfiguredInLiveBootstrap } = await import("../src/lib/auth-secret-guard");
    expect(() =>
      assertAuthSecretConfiguredInLiveBootstrap({ NODE_ENV: "development" } as NodeJS.ProcessEnv)
    ).not.toThrow();
    expect(() =>
      assertAuthSecretConfiguredInLiveBootstrap({
        DB_BOOTSTRAP: "fresh"
      } as unknown as NodeJS.ProcessEnv)
    ).not.toThrow();
  });
});
