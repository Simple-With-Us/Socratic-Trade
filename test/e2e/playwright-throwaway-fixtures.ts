import { createHash } from "node:crypto";

/** 64-char hex throwaway DB encryption key for Playwright `next start` (not a production secret). */
export function playwrightThrowawayEncryptionKey(): string {
  const fromEnv = process.env.PLAYWRIGHT_ENCRYPTION_KEY?.trim();
  if (fromEnv) return fromEnv;
  return createHash("sha256").update("socratic-trade-playwright-throwaway-encryption-v1").digest("hex");
}
