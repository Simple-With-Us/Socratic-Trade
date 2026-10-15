/**
 * Shared Auth.js secret for the Playwright webServer and installPlaywrightSession.
 * Local runs use a fixed fixture so the server and JWT stay aligned. CI must set
 * PLAYWRIGHT_AUTH_SECRET in the workflow env (not Infisical — throwaway smoke only).
 */
export const PLAYWRIGHT_AUTH_SECRET_FIXTURE = "playwright-e2e-auth-secret-32chars!!";

type PlaywrightAuthEnv = { CI?: string; PLAYWRIGHT_AUTH_SECRET?: string };

export function resolvePlaywrightAuthSecret(env: PlaywrightAuthEnv = process.env as PlaywrightAuthEnv): string {
  const fromEnv = String(env.PLAYWRIGHT_AUTH_SECRET || "").trim();
  if (fromEnv) return fromEnv;
  if (env.CI === "true") {
    throw new Error(
      "PLAYWRIGHT_AUTH_SECRET is required in CI. Set it in the Playwright workflow env so webServer AUTH_SECRET and the test JWT share one value."
    );
  }
  return PLAYWRIGHT_AUTH_SECRET_FIXTURE;
}
