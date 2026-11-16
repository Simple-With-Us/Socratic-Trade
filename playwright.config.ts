import { defineConfig, devices } from "@playwright/test";
import { playwrightThrowawayEncryptionKey } from "./test/e2e/playwright-throwaway-fixtures";

const port = Number(process.env.PLAYWRIGHT_PORT || 4201);
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;
const healthURL = `${baseURL}/api/health`;
const webServerCommand =
  process.env.PLAYWRIGHT_WEB_SERVER_COMMAND || `npm run build && npm run start -- -H 127.0.0.1 -p ${port}`;

// The smoke server is started with `next start` (NODE_ENV=production), so the auth middleware fails
// closed and redirects `/` to `/access-denied` for an unauthenticated request — the dashboard never
// renders. CF_ACCESS_TRUST_EMAIL_HEADER can no longer provide that identity: since the CF-Access
// JWT hardening, the plain email header is only trusted alongside CF_ACCESS_TEAM_DOMAIN +
// CF_ACCESS_AUD and a verifiable Cf-Access-Jwt-Assertion, none of which CI can produce. Instead the
// smoke server runs with auth UNCONFIGURED (no AUTH_SECRET, no CF flag), which engages the
// middleware's documented dev/local fallback to PRIMARY_USER_EMAIL — the same path local
// `next start` uses. The smoke email is the server's PRIMARY_USER_EMAIL so it passes the allowlist.
const authEmail = process.env.PLAYWRIGHT_AUTH_EMAIL || "smoke-test@agentic.local";

export default defineConfig({
  testDir: "./test/e2e",
  testIgnore: "**/admin-enrichment-coverage-visual.spec.ts",
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
        // The Coolify CI runner deliberately has low CPU shares so production wins
        // contention; its full Next build can exceed four minutes without being stuck.
        timeout: process.env.CI ? 600_000 : 240_000,
        env: {
          // Deliberately NO CF_ACCESS_TRUST_EMAIL_HEADER and no AUTH_SECRET: auth unconfigured
          // engages the middleware's dev/local fallback to PRIMARY_USER_EMAIL (see comment above).
          PRIMARY_USER_EMAIL: authEmail,
          // The embedded `npm run build` OOMs at V8's default ~2 GB heap on CI runners
          // (Playwright Smoke failed with "Ineffective mark-compacts near heap limit").
          // Set it here, on the spawned server process, so the limit holds regardless of
          // which workflow env the job runs with (e2e.yml also sets this globally).
          NODE_OPTIONS: "--max-old-space-size=3072",
          // Test-only key: next start runs NODE_ENV=production, and the boot guard
          // (assertEncryptionKeyConfiguredInProduction) refuses to boot without a valid
          // 64-char hex ENCRYPTION_KEY. The smoke DB is throwaway, so a fixed key is fine.
          ENCRYPTION_KEY: playwrightThrowawayEncryptionKey()
        }
      },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "mobile-chrome",
      use: { ...devices["iPhone 13"] }
    }
  ]
});
