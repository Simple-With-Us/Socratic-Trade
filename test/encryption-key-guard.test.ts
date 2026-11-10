// Item 14 — ENCRYPTION_KEY boot guard, versioned ciphertext envelope, and the legacy-plaintext
// migration sweep (src/lib/db-api-keys.ts). A real-money trading app must never silently mint a
// per-process ephemeral encryption key in production: stored credentials would become unreadable
// after every restart, and legacy plaintext rows would have no path to ever get encrypted.
//
// Covers:
//   1. assertEncryptionKeyConfiguredInProduction — fails closed in production only.
//   2. encryptValue/decryptValue — versioned v1: envelope, round-trip, and backward compatibility
//      with the PRE-VERSIONING bare iv:tag:ct envelope (same algorithm/key derivation).
//   3. isEncryptedValue — the strict detector the migration sweep uses.
//   4. migrateLegacyPlaintextCredentials(IfKeyConfigured) — one-time, idempotent, audited sweep.
import { randomUUID } from "node:crypto";
import * as nodeCrypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-enc-guard-${randomUUID()}.db`)}`;
});

afterAll(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("assertEncryptionKeyConfiguredInProduction — fail-closed boot guard", () => {
  it("throws in production when ENCRYPTION_KEY is missing", async () => {
    const { assertEncryptionKeyConfiguredInProduction } = await import("../src/lib/db-api-keys");
    expect(() =>
      assertEncryptionKeyConfiguredInProduction({ NODE_ENV: "production" } as NodeJS.ProcessEnv)
    ).toThrow(/ENCRYPTION_KEY is missing or invalid in production/);
  });

  it("throws in production when ENCRYPTION_KEY is malformed (not 64 hex chars)", async () => {
    const { assertEncryptionKeyConfiguredInProduction } = await import("../src/lib/db-api-keys");
    expect(() =>
      assertEncryptionKeyConfiguredInProduction({
        NODE_ENV: "production",
        ENCRYPTION_KEY: "not-hex-and-too-short"
      } as NodeJS.ProcessEnv)
    ).toThrow(/ENCRYPTION_KEY is missing or invalid in production/);
  });

  it("does not throw in production when ENCRYPTION_KEY is a valid 64-char hex string", async () => {
    const { assertEncryptionKeyConfiguredInProduction } = await import("../src/lib/db-api-keys");
    expect(() =>
      assertEncryptionKeyConfiguredInProduction({
        NODE_ENV: "production",
        ENCRYPTION_KEY: "a".repeat(64)
      } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });

  it("never throws outside production, even when ENCRYPTION_KEY is missing (dev/test keep the warning-only path)", async () => {
    const { assertEncryptionKeyConfiguredInProduction } = await import("../src/lib/db-api-keys");
    expect(() =>
      assertEncryptionKeyConfiguredInProduction({ NODE_ENV: "development" } as NodeJS.ProcessEnv)
    ).not.toThrow();
    expect(() =>
      assertEncryptionKeyConfiguredInProduction({ NODE_ENV: "test" } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });
});

describe("versioned ciphertext envelope (v1:) + backward compatibility", () => {
  it("encryptValue writes the v1:-prefixed envelope; decryptValue round-trips it", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "b".repeat(64));
    const { encryptValue, decryptValue } = await import("../src/lib/db-api-keys");
    const ciphertext = encryptValue("super-secret-api-key-12345");
    expect(ciphertext.startsWith("v1:")).toBe(true);
    expect(ciphertext.slice(3).split(":")).toHaveLength(3);
    expect(decryptValue(ciphertext)).toBe("super-secret-api-key-12345");
  });

  it("decryptValue still decrypts a PRE-VERSIONING bare iv:tag:ct envelope under the SAME algorithm/key", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "c".repeat(64));
    const { decryptValue } = await import("../src/lib/db-api-keys");

    // Hand-roll the exact pre-versioning envelope shape (no "v1:" prefix) with the SAME
    // algorithm/key derivation encryptValue uses, proving the owner's existing prod
    // ENCRYPTION_KEY keeps decrypting every already-encrypted row with zero re-encryption needed.
    const key = Buffer.from("c".repeat(64), "hex");
    const iv = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
    let ct = cipher.update("legacy-plaintext-before-versioning", "utf8", "hex");
    ct += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");
    const legacyEnvelope = `${iv.toString("hex")}:${authTag}:${ct}`; // no "v1:" prefix

    expect(decryptValue(legacyEnvelope)).toBe("legacy-plaintext-before-versioning");
  });

  it("decryptValue rejects genuine plaintext (P0-5 fail-closed; migrate first)", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "d".repeat(64));
    const { decryptValue } = await import("../src/lib/db-api-keys");
    expect(decryptValue("sk-plain-not-encrypted-at-all")).toBe("");
  });
});

describe("isEncryptedValue — strict detector used by the migration sweep", () => {
  it("recognizes both the v1: envelope and the pre-versioning bare envelope; rejects plaintext", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "e".repeat(64));
    const { encryptValue, isEncryptedValue } = await import("../src/lib/db-api-keys");
    const versioned = encryptValue("some-secret");
    expect(isEncryptedValue(versioned)).toBe(true);
    expect(isEncryptedValue(versioned.slice(3))).toBe(true); // bare, pre-versioning shape
    expect(isEncryptedValue("plain-api-key-not-encrypted")).toBe(false);
    expect(isEncryptedValue("sk-abc:def")).toBe(false); // 2 colons, not our 3-part envelope
  });
});

describe("migrateLegacyPlaintextCredentials — one-time idempotent audited sweep", () => {
  it("re-encrypts plaintext rows in place; leaves already-encrypted rows byte-for-byte untouched", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "f".repeat(64));
    const { getDb } = await import("../src/lib/db");
    const { encryptValue, decryptValue, isEncryptedValue, migrateLegacyPlaintextCredentials } =
      await import("../src/lib/db-api-keys");

    const db = getDb();
    const now = new Date().toISOString();

    // A plaintext user_api_keys row (as if written before field-level encryption existed).
    db.prepare(
      `INSERT INTO user_api_keys (id, user_id, service, api_key, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("local_openai", "local", "openai", "sk-plaintext-legacy-key", null, now, now);

    // An already-encrypted user_api_keys row — must NOT be re-encrypted/rotated.
    const alreadyEncrypted = encryptValue("sk-already-encrypted-key");
    db.prepare(
      `INSERT INTO user_api_keys (id, user_id, service, api_key, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("local_anthropic", "local", "anthropic", alreadyEncrypted, null, now, now);

    // A connected_accounts row with plaintext api_key/api_secret (a pre-encryption-era row —
    // bypassing upsertConnectedAccount, which always encrypts on write).
    db.prepare(
      `INSERT INTO connected_accounts (id, user_id, broker, environment, account_number, label, api_key, api_secret, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), "local", "alpaca", "paper", "PA-LEGACY", "Legacy", "plaintext-broker-key", "plaintext-broker-secret", 0, now, now);

    const result = migrateLegacyPlaintextCredentials();
    expect(result.apiKeysMigrated).toBe(1);
    expect(result.connectedAccountFieldsMigrated).toBe(2);

    const migratedRow = db.prepare("SELECT api_key FROM user_api_keys WHERE id = ?").get("local_openai") as { api_key: string };
    expect(isEncryptedValue(migratedRow.api_key)).toBe(true);
    expect(decryptValue(migratedRow.api_key)).toBe("sk-plaintext-legacy-key");

    const untouchedRow = db.prepare("SELECT api_key FROM user_api_keys WHERE id = ?").get("local_anthropic") as { api_key: string };
    expect(untouchedRow.api_key).toBe(alreadyEncrypted);

    const acctRow = db
      .prepare("SELECT api_key, api_secret FROM connected_accounts WHERE account_number = ?")
      .get("PA-LEGACY") as { api_key: string; api_secret: string };
    expect(decryptValue(acctRow.api_key)).toBe("plaintext-broker-key");
    expect(decryptValue(acctRow.api_secret)).toBe("plaintext-broker-secret");

    // Idempotent: a second sweep finds nothing left to migrate.
    expect(migrateLegacyPlaintextCredentials()).toEqual({ apiKeysMigrated: 0, connectedAccountFieldsMigrated: 0 });
  });

  it("audits the migration only when rows are actually re-encrypted", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "1".repeat(64));
    const { getDb } = await import("../src/lib/db");
    const { migrateLegacyPlaintextCredentials } = await import("../src/lib/db-api-keys");
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO user_api_keys (id, user_id, service, api_key, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("local_fmp", "local", "fmp", "plaintext-fmp-key", null, now, now);

    migrateLegacyPlaintextCredentials();

    const auditRow = db
      .prepare("SELECT payload FROM audit_events WHERE kind = 'credential_encryption_migration' ORDER BY created_at DESC LIMIT 1")
      .get() as { payload: string } | undefined;
    expect(auditRow).toBeDefined();
    expect(JSON.parse(auditRow!.payload)).toMatchObject({ apiKeysMigrated: 1 });

    // A no-op sweep (nothing left to migrate) does not add another audit row.
    const auditCountBefore = (db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'credential_encryption_migration'").get() as { n: number }).n;
    migrateLegacyPlaintextCredentials();
    const auditCountAfter = (db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'credential_encryption_migration'").get() as { n: number }).n;
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  it("migrateLegacyPlaintextCredentialsIfKeyConfigured no-ops on the ephemeral fallback key (ENCRYPTION_KEY unset)", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    const { getDb } = await import("../src/lib/db");
    const { migrateLegacyPlaintextCredentialsIfKeyConfigured } = await import("../src/lib/db-api-keys");
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO user_api_keys (id, user_id, service, api_key, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("local_deepseek", "local", "deepseek", "plaintext-deepseek-key", null, now, now);

    expect(migrateLegacyPlaintextCredentialsIfKeyConfigured()).toBeNull();
    // Untouched: still plaintext, since re-encrypting under a throwaway ephemeral key would make
    // the row LESS recoverable, not more.
    const row = db.prepare("SELECT api_key FROM user_api_keys WHERE id = ?").get("local_deepseek") as { api_key: string };
    expect(row.api_key).toBe("plaintext-deepseek-key");
  });

  it("migrateLegacyPlaintextCredentialsIfKeyConfigured runs the sweep when a real key IS configured", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "2".repeat(64));
    const { getDb } = await import("../src/lib/db");
    const { migrateLegacyPlaintextCredentialsIfKeyConfigured } = await import("../src/lib/db-api-keys");
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO user_api_keys (id, user_id, service, api_key, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("local_mistral", "local", "mistral", "plaintext-mistral-key", null, now, now);

    expect(migrateLegacyPlaintextCredentialsIfKeyConfigured()).toEqual({ apiKeysMigrated: 1, connectedAccountFieldsMigrated: 0 });
  });
});
