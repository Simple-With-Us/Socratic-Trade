import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Each test file gets its own isolated SQLite db so db module singleton state does not leak
// between test files (mirrors the pattern in test/data-providers.test.ts).
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-quiver-provider-${randomUUID()}.db`)}`;
  process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
  process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
});

describe("QuiverQuant enrichment provider", () => {
  const originalKey = process.env.QUIVER_API_KEY;
  const originalNegTtl = process.env.QUIVER_NEGATIVE_CACHE_TTL_MS;
  const originalTtl = process.env.QUIVER_CACHE_TTL_MS;

  beforeEach(async () => {
    delete process.env.QUIVER_API_KEY;
    delete process.env.QUIVER_NEGATIVE_CACHE_TTL_MS;
    delete process.env.QUIVER_CACHE_TTL_MS;
    const { clearQuiverCache } = await import("../src/lib/quiver-provider");
    clearQuiverCache();
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    if (originalKey) process.env.QUIVER_API_KEY = originalKey;
    else delete process.env.QUIVER_API_KEY;
    if (originalNegTtl) process.env.QUIVER_NEGATIVE_CACHE_TTL_MS = originalNegTtl;
    else delete process.env.QUIVER_NEGATIVE_CACHE_TTL_MS;
    if (originalTtl) process.env.QUIVER_CACHE_TTL_MS = originalTtl;
    else delete process.env.QUIVER_CACHE_TTL_MS;
    const { clearQuiverCache } = await import("../src/lib/quiver-provider");
    clearQuiverCache();
    vi.unstubAllGlobals();
  });

  // ── Registration gating ────────────────────────────────────────────────────

  it("is never registered when QUIVER_API_KEY is absent", async () => {
    delete process.env.QUIVER_API_KEY;
    // Keep default-on Congress fundamentals from network-touching this registration check.
    process.env.CONGRESS_TRADE_FUNDAMENTALS_ENABLED = "off";
    const { getEnrichmentProvider } = await import("../src/lib/data-providers");
    const provider = getEnrichmentProvider();
    expect(provider.name).not.toContain("quiverquant");
  });

  it("is NEVER registered even when QUIVER_API_KEY is present (retired direct vendor)", async () => {
    process.env.QUIVER_API_KEY = "test-quiver-key";
    process.env.CONGRESS_TRADE_FUNDAMENTALS_ENABLED = "off";
    const { getEnrichmentProvider } = await import("../src/lib/data-providers");
    const provider = getEnrichmentProvider();
    expect(provider.name).not.toContain("quiverquant");
  });

  it("resolveQuiverApiKey always returns undefined (direct Quiver retired)", async () => {
    const { resolveQuiverApiKey } = await import("../src/lib/quiver-provider");
    process.env.QUIVER_API_KEY = "  abc123  ";
    expect(resolveQuiverApiKey()).toBeUndefined();
    process.env.QUIVER_API_KEY = "   ";
    expect(resolveQuiverApiKey()).toBeUndefined();
    delete process.env.QUIVER_API_KEY;
    expect(resolveQuiverApiKey()).toBeUndefined();
  });

  it("resolveQuiverApiKey ignores QUIVERQUANT_API_TOKEN as well (retired)", async () => {
    const { resolveQuiverApiKey } = await import("../src/lib/quiver-provider");
    delete process.env.QUIVER_API_KEY;
    process.env.QUIVERQUANT_API_TOKEN = "token-spelling";
    expect(resolveQuiverApiKey()).toBeUndefined();
    process.env.QUIVER_API_KEY = "primary";
    expect(resolveQuiverApiKey()).toBeUndefined();
    delete process.env.QUIVER_API_KEY;
    delete process.env.QUIVERQUANT_API_TOKEN;
  });

  it("enrich is a no-op even if the class is constructed with a key", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { QuiverEnrichmentProvider } = await import("../src/lib/quiver-provider");
    const provider = new QuiverEnrichmentProvider("test-key");
    await expect(provider.enrich(["AAPL"])).resolves.toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── Row extraction / parsing (fixture payloads, both schema shapes seen from QuiverQuant) ──

  it("extractQuiverRows accepts a bare array and tolerates a wrapped envelope", async () => {
    const { extractQuiverRows } = await import("../src/lib/quiver-provider");
    expect(extractQuiverRows([{ a: 1 }, { a: 2 }])).toHaveLength(2);
    expect(extractQuiverRows({ results: [{ a: 1 }] })).toHaveLength(1);
    expect(extractQuiverRows({ data: [{ a: 1 }] })).toHaveLength(1);
    expect(extractQuiverRows(null)).toEqual([]);
    expect(extractQuiverRows({ nothing: true })).toEqual([]);
  });

  it("parseCongressTradesCount counts only rows within the trailing 180-day window", async () => {
    const { parseCongressTradesCount } = await import("../src/lib/quiver-provider");
    const now = Date.parse("2026-07-15T00:00:00Z");
    const rows = [
      // snake_case shape (as observed live) — within window
      { ticker: "AAPL", traded: "2026-06-24", filed: "2026-07-08" },
      // PascalCase shape (documented beta schema) — within window
      { Ticker: "AAPL", TransactionDate: "2026-05-01" },
      // stale — outside the 180-day window
      { ticker: "AAPL", traded: "2025-01-01", filed: "2025-01-15" },
      // unparseable date — excluded, never fabricated
      { ticker: "AAPL", traded: "not-a-date" }
    ];
    expect(parseCongressTradesCount(rows, now)).toBe(2);
    expect(parseCongressTradesCount([], now)).toBe(0);
  });

  it("parseInsiderTradesCount counts only rows within the trailing 90-day window", async () => {
    const { parseInsiderTradesCount } = await import("../src/lib/quiver-provider");
    const now = Date.parse("2026-07-15T00:00:00Z");
    const rows = [
      { ticker: "AAPL", date: "2026-06-16", file_date: "2026-06-17" }, // within
      { Ticker: "AAPL", TransactionDate: "2026-07-01" }, // within
      { ticker: "AAPL", date: "2026-01-01" } // stale
    ];
    expect(parseInsiderTradesCount(rows, now)).toBe(2);
  });

  it("parseGovContractsTotal sums $ obligated within the trailing 365-day window, tolerant of field casing", async () => {
    const { parseGovContractsTotal } = await import("../src/lib/quiver-provider");
    const now = Date.parse("2026-07-15T00:00:00Z");
    const rows = [
      { action_date: "2026-05-05 00:00:00", total_dollars_obligated: 58060.0 }, // within
      { ActionDate: "2026-01-10", TotalDollarsObligated: 1000 }, // within
      { action_date: "2024-01-01", total_dollars_obligated: 999999 } // stale — excluded
    ];
    expect(parseGovContractsTotal(rows, now)).toBe(59060);
  });

  it("parseLobbyingTotal sums $ within the trailing 365 days, falling back to Jan 1 of `year` when no date field is present", async () => {
    const { parseLobbyingTotal } = await import("../src/lib/quiver-provider");
    const now = Date.parse("2026-07-15T00:00:00Z");
    const rows = [
      { amount: 2480000, date: "2026-04-20", year: 2026 }, // within, has explicit date
      { Amount: 40000, year: 2026 }, // within, falls back to 2026-01-01
      { amount: 110000, year: 2023 } // stale via year fallback — excluded
    ];
    expect(parseLobbyingTotal(rows, now)).toBe(2520000);
  });

  it("parsePatentsCount counts only patents published within the trailing 180-day window", async () => {
    const { parsePatentsCount } = await import("../src/lib/quiver-provider");
    const now = Date.parse("2026-07-15T00:00:00Z");
    const rows = [
      { pub_date: "2026-07-07", title: "attachment system" },
      { PubDate: "2026-06-01", title: "retinal tracking" },
      { pub_date: "2025-01-01", title: "stale patent" }
    ];
    expect(parsePatentsCount(rows, now)).toBe(2);
  });

  // ── Provider enrich() — permanently retired (no network, empty result) ──

  it("enrich() is a permanent no-op and never fetches (direct Quiver retired)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { QuiverEnrichmentProvider } = await import("../src/lib/quiver-provider");
    const provider = new QuiverEnrichmentProvider("test-key");
    await expect(provider.enrich(["AAPL", "MSFT"])).resolves.toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never throws out of enrich() (fail-open empty object)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("total outage"); }));
    const { QuiverEnrichmentProvider } = await import("../src/lib/quiver-provider");
    const provider = new QuiverEnrichmentProvider("test-key");
    await expect(provider.enrich(["GME"])).resolves.toEqual({});
  });

  it("cascade integration: retired Quiver contributes no fields or sources", async () => {
    const { QuiverEnrichmentProvider } = await import("../src/lib/quiver-provider");
    const { CascadingEnrichmentProvider } = await import("../src/lib/data-providers");
    const provider = new QuiverEnrichmentProvider("test-key");
    const cascade = new CascadingEnrichmentProvider([provider]);
    const merged = await cascade.enrich(["AMZN"]);
    expect(merged.AMZN?.congressTradesQuiver).toBeUndefined();
    expect(merged.AMZN?.govContractsQuiver).toBeUndefined();
    expect(merged.AMZN?.sources?.congressTradesQuiver).toBeUndefined();
  });
});
