import type { BrowserContext } from "@playwright/test";
import { encodeSessionToken } from "../../src/lib/auth/session-token";

/** Must match `webServer.env.AUTH_SECRET` in playwright.config.ts. */
export const PLAYWRIGHT_AUTH_SECRET =
  process.env.PLAYWRIGHT_AUTH_SECRET || "playwright-e2e-auth-secret-32chars!!";

export const PLAYWRIGHT_AUTH_EMAIL =
  process.env.PLAYWRIGHT_AUTH_EMAIL || "smoke-test@agentic.local";

/** Auth.js session so middleware + admin layout see a verified primary operator. */
export async function installPlaywrightSession(context: BrowserContext): Promise<void> {
  const jwt = await encodeSessionToken({
    token: { email: PLAYWRIGHT_AUTH_EMAIL, loginAt: Date.now() },
    secret: PLAYWRIGHT_AUTH_SECRET,
    salt: "authjs.session-token",
    maxAge: 60 * 60
  });
  const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:4201";
  await context.addCookies([
    {
      name: "authjs.session-token",
      value: jwt,
      url: baseURL,
      httpOnly: true,
      sameSite: "Lax"
    }
  ]);
}
