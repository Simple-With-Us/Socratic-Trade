import type { BrowserContext } from "@playwright/test";
import { encodeSessionToken } from "../../src/lib/auth/session-token";

/** Must match `webServer.env.AUTH_SECRET` in playwright.config.ts. */
export const PLAYWRIGHT_AUTH_SECRET =
  process.env.PLAYWRIGHT_AUTH_SECRET || "playwright-e2e-auth-secret-32chars!!";

export const PLAYWRIGHT_AUTH_EMAIL =
  process.env.PLAYWRIGHT_AUTH_EMAIL || "smoke-test@agentic.local";

/** Same origin as playwright.config.ts, including a PLAYWRIGHT_PORT override. */
export function playwrightBaseURL(
  baseURL: string | undefined = process.env.PLAYWRIGHT_BASE_URL,
  port: string | undefined = process.env.PLAYWRIGHT_PORT
): string {
  if (baseURL) return baseURL;
  return `http://127.0.0.1:${Number(port || 4201)}`;
}

/** Auth.js session so middleware + admin layout see a verified primary operator. */
export async function installPlaywrightSession(context: BrowserContext): Promise<void> {
  const jwt = await encodeSessionToken({
    token: { email: PLAYWRIGHT_AUTH_EMAIL, loginAt: Date.now() },
    secret: PLAYWRIGHT_AUTH_SECRET,
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
