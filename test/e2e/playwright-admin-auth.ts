import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const secretFilePath = join(
  dirname(fileURLToPath(import.meta.url)),
  ".playwright-admin-auth-secret.local"
);

/**
 * Auth.js secret for the admin-only Playwright webServer. In CI, set `PLAYWRIGHT_AUTH_SECRET`
 * (see `.github/workflows/e2e.yml`). Locally, a per-worktree file is created on first use.
 */
export function playwrightAdminAuthSecret(): string {
  const fromEnv = process.env.PLAYWRIGHT_AUTH_SECRET?.trim();
  if (fromEnv) return fromEnv;

  if (existsSync(secretFilePath)) {
    return readFileSync(secretFilePath, "utf8").trim();
  }

  if (process.env.CI) {
    throw new Error(
      "PLAYWRIGHT_AUTH_SECRET is required in CI for admin Playwright e2e (openssl rand -hex 32 in e2e.yml)"
    );
  }

  const secret = randomBytes(32).toString("hex");
  writeFileSync(secretFilePath, `${secret}\n`, { mode: 0o600 });
  return secret;
}
