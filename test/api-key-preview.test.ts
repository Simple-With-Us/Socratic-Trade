/**
 * Masked key previews on GET /api/keys.
 *
 * The key store is write-only, which left one question unanswerable: when several keys exist for one
 * provider (the recurring cost of a key being provisioned outside the owner's guardrails), WHICH one
 * is actually serving? `preview` answers it with the first-8/last-4 elision and nothing more.
 *
 * The two rules that matter here: a preview is never a usable value, and the operator's env
 * credential is previewable only to an operator — a tenant riding the shared key learns that one is
 * serving them, never anything about it.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const OWNER_EMAIL = "owner@example.com";
const TENANT_EMAIL = "tenant@example.com";
const OPENROUTER_KEY = "mock-key-v1-0123456789abcdef0123456789abcdef";
const TENANT_KEY = "mock-key-v1-ffffffffffffffffffffffffffffffff";
const SHARED_KEY = "finnhub-shared-operator-key-9999";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-key-preview-${randomUUID()}.db`)}`;
});

afterEach(() => vi.unstubAllEnvs());

/** Call GET /api/keys as `email`, with the identity headers middleware would have set. */
async function listKeys(email: string): Promise<Array<{ service: string; source: string; preview?: string }>> {
  const { NextRequest } = await import("next/server");
  const { GET } = await import("../app/api/keys/route");
  const res = await GET(
    new NextRequest("http://localhost/api/keys", {
      headers: {
        "x-authenticated-user-email": email,
        "x-authenticated-identity-source": "authjs-session"
      }
    })
  );
  const body = (await res.json()) as { keys: Array<{ service: string; source: string; preview?: string }> };
  return body.keys;
}

const openrouterOf = (keys: Array<{ service: string; source: string; preview?: string }>) =>
  keys.find((k) => k.service === "openrouter")!;

describe("GET /api/keys — masked key preview", () => {
  it("previews your OWN stored key as first-8...last-4, never the usable value", async () => {
    vi.stubEnv("PRIMARY_USER_EMAIL", OWNER_EMAIL);
    const { upsertUserApiKey, getDb } = await import("../src/lib/db");
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    getDb();
    upsertUserApiKey(userIdForEmail(OWNER_EMAIL), "openrouter", OPENROUTER_KEY);

    const entry = openrouterOf(await listKeys(OWNER_EMAIL));
    expect(entry.source).toBe("user");
    expect(entry.preview).toBe("mock-key...cdef");
    // The elision is the whole point: the preview must not be the key, nor contain its middle.
    expect(entry.preview).not.toBe(OPENROUTER_KEY);
    expect(OPENROUTER_KEY).toContain("789abcdef01");
    expect(entry.preview).not.toContain("789abcdef01");
  });

  it("withholds the operator's env-key preview from a tenant it is serving, but shows it to the operator", async () => {
    vi.stubEnv("PRIMARY_USER_EMAIL", OWNER_EMAIL);
    vi.stubEnv("ADMIN_USER_EMAILS", "");
    // finnhub is shared-operator-infra, so the operator's env key genuinely serves every tenant —
    // the only tier where a non-operator ever sees source "env". (LLM keys are per-user-only: no
    // env fallback for anyone, so an LLM row can never leak the operator's key this way.)
    vi.stubEnv("FINNHUB_API_KEY", SHARED_KEY);
    const { getDb } = await import("../src/lib/db");
    getDb();

    const tenantEntry = (await listKeys(TENANT_EMAIL)).find((k) => k.service === "finnhub")!;
    // The tenant still learns a server key is serving them — just nothing about it.
    expect(tenantEntry.source).toBe("env");
    expect(tenantEntry.preview).toBeUndefined();

    const ownerEntry = (await listKeys(OWNER_EMAIL)).find((k) => k.service === "finnhub")!;
    expect(ownerEntry.source).toBe("env");
    expect(ownerEntry.preview).toBe("finnhub-...9999");
  });

  it("shows a tenant their OWN key even though the operator's stays hidden", async () => {
    vi.stubEnv("PRIMARY_USER_EMAIL", OWNER_EMAIL);
    vi.stubEnv("ADMIN_USER_EMAILS", "");
    vi.stubEnv("OPENROUTER_API_KEY", OPENROUTER_KEY);
    const { getDb, upsertUserApiKey } = await import("../src/lib/db");
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    getDb();
    upsertUserApiKey(userIdForEmail(TENANT_EMAIL), "openrouter", TENANT_KEY);

    const entry = openrouterOf(await listKeys(TENANT_EMAIL));
    expect(entry.source).toBe("user");
    expect(entry.preview).toBe("mock-key...ffff");
  });
});

describe("maskApiKeyPreview", () => {
  it("elides the middle and refuses keys too short to elide", async () => {
    const { maskApiKeyPreview } = await import("../src/lib/db-api-keys");
    expect(maskApiKeyPreview(OPENROUTER_KEY)).toBe("mock-key...cdef");
    expect(maskApiKeyPreview("  padded-key-value-1234  ")).toBe("padded-k...1234");
    expect(maskApiKeyPreview(undefined)).toBeUndefined();
    expect(maskApiKeyPreview("")).toBeUndefined();
    expect(maskApiKeyPreview("   ")).toBeUndefined();
    // 12 chars: revealing 8+4 would be the entire secret.
    expect(maskApiKeyPreview("123456789012")).toBeUndefined();
    expect(maskApiKeyPreview("1234567890123")).toBe("12345678...0123");
  });

  it("stays the single source of truth for the admin ledger's mask", async () => {
    const { maskApiKey } = await import("../src/lib/llm-usage");
    expect(maskApiKey(OPENROUTER_KEY)).toBe("mock-key...cdef");
    // Too short to elide → head-only, since the ledger descriptor always needs a string.
    expect(maskApiKey("short")).toBe("shor...");
  });
});
