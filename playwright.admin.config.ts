import { defineConfig, devices } from "@playwright/test";
import { playwrightAdminAuthSecret } from "./test/e2e/playwright-admin-auth";
import { playwrightThrowawayEncryptionKey } from "./test/e2e/playwright-throwaway-fixtures";

const port = Number(process.env.PLAYWRIGHT_ADMIN_PORT || 4202);
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;
const healthURL = `${baseURL}/api/health`;
const webServerCommand =
  process.env.PLAYWRIGHT_WEB_SERVER_COMMAND || `npm run build && npm run start -- -H 127.0.0.1 -p ${port}`;

const authEmail = process.env.PLAYWRIGHT_AUTH_EMAIL || "smoke-test@agentic.local";
const adminAuthSecret = playwrightAdminAuthSecret();

/**
 * Admin UI e2e only. `/admin/**` layout requires `isVerifiedIdentitySource` (Auth.js session or CF Access),
 * which the default smoke harness deliberately does NOT arm — see `playwright.config.ts`.
 */
export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "**/admin-enrichment-coverage-visual.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    extraHTTPHeaders: { "cf-access-authenticated-user-email": authEmail }
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: webServerCommand,
        url: healthURL,
        reuseExistingServer: !process.env.CI,
        timeout: process.env.CI ? 600_000 : 240_000,
        env: {
          PRIMARY_USER_EMAIL: authEmail,
          AUTH_SECRET: adminAuthSecret,
          NODE_OPTIONS: "--max-old-space-size=3072",
          ENCRYPTION_KEY: playwrightThrowawayEncryptionKey()
        }
      },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
