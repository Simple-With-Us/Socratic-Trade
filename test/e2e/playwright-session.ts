import type { BrowserContext } from "@playwright/test";
import { encodeSessionToken } from "../../src/lib/auth/session-token";
import { resolvePlaywrightAuthSecret } from "./playwright-auth-secret";
import { playwrightBaseURL } from "./playwright-base-url";

export const PLAYWRIGHT_AUTH_EMAIL =
  process.env.PLAYWRIGHT_AUTH_EMAIL || "smoke-test@agentic.local";

/** Auth.js session so middleware + admin layout see a verified primary operator. */
export async function installPlaywrightSession(context: BrowserContext): Promise<void> {
  const authSecret = resolvePlaywrightAuthSecret();
  const jwt = await encodeSessionToken({
    token: { email: PLAYWRIGHT_AUTH_EMAIL, loginAt: Date.now() },
    secret: authSecret,
    salt: "authjs.session-token",
    maxAge: 60 * 60
  });
  const baseURL = playwrightBaseURL();
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
