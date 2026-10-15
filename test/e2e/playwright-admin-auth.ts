import { createHash } from "node:crypto";

/**
 * Throwaway Auth.js secret for the admin-only Playwright webServer (`playwright.admin.config.ts`).
 * Not production credentials — same class as the fixed `ENCRYPTION_KEY` in `playwright.config.ts`.
 */
export function playwrightAdminAuthSecret(): string {
  const fromEnv = process.env.PLAYWRIGHT_AUTH_SECRET?.trim();
  if (fromEnv) return fromEnv;
  return createHash("sha256").update("socratic-trade-playwright-admin-auth-v1").digest("hex");
}
