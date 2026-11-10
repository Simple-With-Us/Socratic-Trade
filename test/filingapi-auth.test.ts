import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFilingApiKeyRejected,
  filingApiKeyFingerprint,
  isFilingApiAuthErrorText,
  isFilingApiAuthStatus,
  isFilingApiKeyRejected,
  markFilingApiKeyRejected,
  resetFilingApiAuthMemoryForTests,
  resetFilingApiAuthStateForTests,
  shouldUseFilingApiKey
} from "../src/lib/filingapi-auth";
import { resetDurableStateCacheForTests } from "../src/lib/durable-state";
import { getDb } from "../src/lib/db";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-filingapi-auth-${randomUUID()}.db`)}`;
  process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
  process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
  getDb();
});

describe("filingapi-auth", () => {
  beforeEach(() => {
    resetFilingApiAuthStateForTests();
  });

  it("fingerprints the secret without storing it and rejects only that fingerprint", () => {
    const a = "dead-trial-key";
    const b = "replacement-key";
    expect(filingApiKeyFingerprint(a)).toHaveLength(64);
    expect(filingApiKeyFingerprint(a)).not.toBe(a);
    markFilingApiKeyRejected(a);
    expect(isFilingApiKeyRejected(a)).toBe(true);
    expect(isFilingApiKeyRejected(b)).toBe(false);
    expect(shouldUseFilingApiKey(a)).toBe(false);
    expect(shouldUseFilingApiKey(b)).toBe(true);
    clearFilingApiKeyRejected(a);
    expect(shouldUseFilingApiKey(a)).toBe(true);
  });

  it("treats missing keys as skip, not as rejected", () => {
    expect(shouldUseFilingApiKey(undefined)).toBe(false);
    expect(shouldUseFilingApiKey("")).toBe(false);
    expect(shouldUseFilingApiKey("   ")).toBe(false);
    expect(isFilingApiKeyRejected(undefined)).toBe(false);
  });

  it("durable reject survives a new module state / re-read", () => {
    markFilingApiKeyRejected("dead-trial-key");
    expect(shouldUseFilingApiKey("dead-trial-key")).toBe(false);

    // Simulate a process restart: drop the in-memory set and durable-state
    // hydration cache, leave the SQLite row.  shouldUseFilingApiKey must
    // re-read the rejected fingerprint from durable_state.
    resetFilingApiAuthMemoryForTests();
    resetDurableStateCacheForTests("filingapi");
    expect(isFilingApiKeyRejected("dead-trial-key")).toBe(true);
    expect(shouldUseFilingApiKey("dead-trial-key")).toBe(false);
    expect(shouldUseFilingApiKey("replacement-key")).toBe(true);
  });

  it("classifies 401/403 statuses and unauthorized text", () => {
    expect(isFilingApiAuthStatus(401)).toBe(true);
    expect(isFilingApiAuthStatus(403)).toBe(true);
    expect(isFilingApiAuthStatus(429)).toBe(false);
    expect(isFilingApiAuthErrorText("HTTP 401 Unauthorized")).toBe(true);
    expect(isFilingApiAuthErrorText("invalid api key")).toBe(true);
    expect(isFilingApiAuthErrorText("HTTP 500 boom")).toBe(false);
  });
});

describe("FilingAPI cascade + provider skip", () => {
  const KEYS = ["FILINGAPI", "FILINGAPI_KEY", "FILING_API_KEY"] as const;
  const originals: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};
  for (const k of KEYS) originals[k] = process.env[k];

  beforeEach(async () => {
    resetFilingApiAuthStateForTests();
    for (const k of KEYS) delete process.env[k];
    const { clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    resetFilingApiAuthStateForTests();
    for (const k of KEYS) {
      const v = originals[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.unstubAllGlobals();
  });

  it("does not register the lane when no key is set", async () => {
    const { getEnrichmentProvider } = await import("../src/lib/data-providers");
    expect(getEnrichmentProvider().name).not.toContain("filingapi");
  });

  it("registers when a key is present and drops the lane after that fingerprint is rejected", async () => {
    process.env.FILINGAPI = "live-looking-key";
    const { getEnrichmentProvider } = await import("../src/lib/data-providers");
    expect(getEnrichmentProvider().name).toContain("filingapi");
    markFilingApiKeyRejected("live-looking-key");
    expect(getEnrichmentProvider().name).not.toContain("filingapi");
    expect(getEnrichmentProvider().name).toContain("yahoo-finance");
  });

  it("stops calling filingapi.dev after the first 401; a new fingerprint is tried again", async () => {
    const { FilingApiEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: RequestInfo | URL) => {
      fetchCount += 1;
      const u = String(url);
      if (u.includes("filingapi.dev")) {
        return new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });
      }
      return new Response("unexpected", { status: 500 });
    });

    const dead = new FilingApiEnrichmentProvider("dead-trial-key");
    await dead.enrich(["AAPL"]);
    const afterFirst = fetchCount;
    expect(afterFirst).toBeGreaterThan(0);
    await dead.enrich(["MSFT"]);
    expect(fetchCount).toBe(afterFirst);
    expect(isFilingApiKeyRejected("dead-trial-key")).toBe(true);

    fetchCount = 0;
    vi.stubGlobal("fetch", async (url: RequestInfo | URL) => {
      fetchCount += 1;
      const u = String(url);
      if (u.includes("/v1/company/")) {
        return new Response(JSON.stringify({ ticker: "MSFT", sector: "Technology", industry: "Software" }), {
          status: 200
        });
      }
      if (u.includes("/v1/calendar/earnings")) {
        return new Response(JSON.stringify({ earnings: [] }), { status: 200 });
      }
      if (u.includes("/v1/insiders/")) {
        return new Response(JSON.stringify({ signal: "net_buying" }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const fresh = new FilingApiEnrichmentProvider("replacement-key");
    const res = await fresh.enrich(["MSFT"]);
    expect(fetchCount).toBeGreaterThan(0);
    expect(res.MSFT?.sector).toBe("Technology");
    expect(isFilingApiKeyRejected("replacement-key")).toBe(false);
  });
});
