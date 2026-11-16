import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-api-keys-tombstone-${randomUUID()}.db`)}`;

import {
  deleteUserApiKey,
  getUserApiKey,
  listUserApiKeys,
  migrateLocalEnvCredentials,
  resolveApiKeyWithSource,
  resolveLlmCredential,
  upsertUserApiKey,
  DELETED_KEY_TOMBSTONE,
  LOCAL_USER
} from "../src/lib/db-api-keys";

describe("API Key Tombstone Deletion (Ghost Key Prevention)", () => {
  const originalEnvGemini = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    deleteUserApiKey(LOCAL_USER, "gemini");
  });

  afterEach(() => {
    if (originalEnvGemini !== undefined) {
      process.env.GEMINI_API_KEY = originalEnvGemini;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("records a tombstone when a user key is deleted", () => {
    upsertUserApiKey(LOCAL_USER, "gemini", "AIzaSyTest12345");
    expect(getUserApiKey(LOCAL_USER, "gemini")?.apiKey).toBe("AIzaSyTest12345");

    deleteUserApiKey(LOCAL_USER, "gemini");

    const keyAfterDelete = getUserApiKey(LOCAL_USER, "gemini");
    expect(keyAfterDelete?.apiKey).toBe(DELETED_KEY_TOMBSTONE);

    // Active keys list does not expose tombstoned keys
    const activeKeys = listUserApiKeys(LOCAL_USER);
    expect(activeKeys.find((k) => k.service === "gemini")).toBeUndefined();
  });

  it("prevents environment fallback when a key is explicitly deleted/tombstoned", () => {
    process.env.GEMINI_API_KEY = "AIzaSyEnvKey999";

    // Before tombstoning, if no DB key existed, it might resolve env key.
    // Now delete explicitly to place tombstone:
    deleteUserApiKey(LOCAL_USER, "gemini");

    const resolved = resolveApiKeyWithSource("gemini", LOCAL_USER);
    expect(resolved.key).toBeUndefined();
    expect(resolved.source).toBe("none");

    const llmResolved = resolveLlmCredential("gemini", LOCAL_USER);
    expect(llmResolved.key).toBeUndefined();
    expect(llmResolved.source).toBe("none");
  });

  it("prevents migrateLocalEnvCredentials from re-instantiating deleted ghost keys", () => {
    process.env.GEMINI_API_KEY = "AIzaSyEnvKey999";
    deleteUserApiKey(LOCAL_USER, "gemini");
    // Coolify re-injects env on the next container boot. deleteUserApiKey also wipes
    // process.env for `local`, so restore the env var to prove migrate honors the tombstone
    // instead of treating it as an empty row.
    process.env.GEMINI_API_KEY = "AIzaSyEnvKey999";

    const result = migrateLocalEnvCredentials();
    expect(result.migrated).not.toContain("gemini");

    const keyState = getUserApiKey(LOCAL_USER, "gemini");
    expect(keyState?.apiKey).toBe(DELETED_KEY_TOMBSTONE);
  });

  it("does not auto-seed Gemini or DeepSeek from env onto the primary account", () => {
    deleteUserApiKey(LOCAL_USER, "deepseek");
    process.env.GEMINI_API_KEY = "AIzaSyEnvKey999";
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-env-test";

    const result = migrateLocalEnvCredentials();
    expect(result.migrated).not.toContain("gemini");
    expect(result.migrated).not.toContain("deepseek");
    expect(process.env.GEMINI_API_KEY).toBeUndefined();
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(resolveLlmCredential("gemini", LOCAL_USER).source).toBe("none");
    expect(resolveLlmCredential("deepseek", LOCAL_USER).source).toBe("none");
  });

  it("tombstones existing env-migrated Gemini/DeepSeek rows but leaves a user-pasted key", () => {
    upsertUserApiKey(LOCAL_USER, "gemini", "AIzaSyMigratedGhost", "migrated from env");
    upsertUserApiKey(LOCAL_USER, "deepseek", "sk-user-pasted-deepseek", "DeepSeek");

    const result = migrateLocalEnvCredentials();
    expect(result.tombstoned).toEqual(["gemini"]);
    expect(getUserApiKey(LOCAL_USER, "gemini")?.apiKey).toBe(DELETED_KEY_TOMBSTONE);
    expect(getUserApiKey(LOCAL_USER, "deepseek")?.apiKey).toBe("sk-user-pasted-deepseek");
    expect(listUserApiKeys(LOCAL_USER).find((k) => k.service === "gemini")).toBeUndefined();
    expect(listUserApiKeys(LOCAL_USER).find((k) => k.service === "deepseek")?.label).toBe("DeepSeek");
  });
});
