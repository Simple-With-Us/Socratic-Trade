import type { BrowserContext } from "@playwright/test";
import { encodeSessionToken } from "../../src/lib/auth/session-token";
import { playwrightAdminAuthSecret } from "./playwright-admin-auth";

export const PLAYWRIGHT_AUTH_EMAIL =
  process.env.PLAYWRIGHT_AUTH_EMAIL || "smoke-test@agentic.local";

/** Auth.js session for admin UI specs (`playwright.admin.config.ts` webServer only). */
export async function installPlaywrightAdminSession(context: BrowserContext): Promise<void> {
  const secret = playwrightAdminAuthSecret();
  const jwt = await encodeSessionToken({
    token: { email: PLAYWRIGHT_AUTH_EMAIL, loginAt: Date.now() },
    secret,
    salt: "authjs.session-token",
    maxAge: 60 * 60
  });
  const baseURL =
    process.env.PLAYWRIGHT_BASE_URL ||
    `http://127.0.0.1:${process.env.PLAYWRIGHT_ADMIN_PORT || 4202}`;
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
