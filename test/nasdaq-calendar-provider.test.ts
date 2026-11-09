import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Each test file gets its own isolated SQLite db so db module singleton state does not leak
// between test files (mirrors the pattern in test/quiver-provider.test.ts).
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-nasdaq-calendar-provider-${randomUUID()}.db`)}`;
  process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
  process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
});

describe("Nasdaq calendar enrichment provider", () => {
  const originalEnabled = process.env.NASDAQ_CALENDAR_ENRICHMENT_ENABLED;
  const originalHorizon = process.env.NASDAQ_CALENDAR_HORIZON_DAYS;
  const originalTtl = process.env.NASDAQ_CALENDAR_CACHE_TTL_MS;
  const originalNegTtl = process.env.NASDAQ_CALENDAR_NEGATIVE_CACHE_TTL_MS;
  const originalMaxSymbols = process.env.NASDAQ_CALENDAR_MAX_SYMBOLS;

  beforeEach(async () => {
    delete process.env.NASDAQ_CALENDAR_ENRICHMENT_ENABLED;
    delete process.env.NASDAQ_CALENDAR_HORIZON_DAYS;
    delete process.env.NASDAQ_CALENDAR_CACHE_TTL_MS;
    delete process.env.NASDAQ_CALENDAR_NEGATIVE_CACHE_TTL_MS;
    delete process.env.NASDAQ_CALENDAR_MAX_SYMBOLS;
    const { clearNasdaqCalendarCache } = await import("../src/lib/nasdaq-calendar-provider");
    clearNasdaqCalendarCache();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  afterEach(async () => {
    if (originalEnabled) process.env.NASDAQ_CALENDAR_ENRICHMENT_ENABLED = originalEnabled;
    else delete process.env.NASDAQ_CALENDAR_ENRICHMENT_ENABLED;
    if (originalHorizon) process.env.NASDAQ_CALENDAR_HORIZON_DAYS = originalHorizon;
    else delete process.env.NASDAQ_CALENDAR_HORIZON_DAYS;
    if (originalTtl) process.env.NASDAQ_CALENDAR_CACHE_TTL_MS = originalTtl;
    else delete process.env.NASDAQ_CALENDAR_CACHE_TTL_MS;
    if (originalNegTtl) process.env.NASDAQ_CALENDAR_NEGATIVE_CACHE_TTL_MS = originalNegTtl;
    else delete process.env.NASDAQ_CALENDAR_NEGATIVE_CACHE_TTL_MS;
    if (originalMaxSymbols) process.env.NASDAQ_CALENDAR_MAX_SYMBOLS = originalMaxSymbols;
    else delete process.env.NASDAQ_CALENDAR_MAX_SYMBOLS;
    const { clearNasdaqCalendarCache } = await import("../src/lib/nasdaq-calendar-provider");
    clearNasdaqCalendarCache();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ── Config flags ────────────────────────────────────────────────────────────

  it("nasdaqCalendarEnabled() defaults to true when unset", async () => {
    const { nasdaqCalendarEnabled } = await import("../src/lib/nasdaq-calendar-provider");
    delete process.env.NASDAQ_CALENDAR_ENRICHMENT_ENABLED;
    expect(nasdaqCalendarEnabled()).toBe(true);
  });

  it("nasdaqCalendarEnabled() respects an explicit opt-out", async () => {
    const { nasdaqCalendarEnabled } = await import("../src/lib/nasdaq-calendar-provider");
    process.env.NASDAQ_CALENDAR_ENRICHMENT_ENABLED = "false";
    expect(nasdaqCalendarEnabled()).toBe(false);
    process.env.NASDAQ_CALENDAR_ENRICHMENT_ENABLED = "0";
    expect(nasdaqCalendarEnabled()).toBe(false);
    process.env.NASDAQ_CALENDAR_ENRICHMENT_ENABLED = "true";
    expect(nasdaqCalendarEnabled()).toBe(true);
  });

  it("nasdaqCalendarHorizonDays() clamps to [7, 90] and falls back to 45 on garbage", async () => {
    const { nasdaqCalendarHorizonDays } = await import("../src/lib/nasdaq-calendar-provider");
    delete process.env.NASDAQ_CALENDAR_HORIZON_DAYS;
    expect(nasdaqCalendarHorizonDays()).toBe(45);
    process.env.NASDAQ_CALENDAR_HORIZON_DAYS = "1";
    expect(nasdaqCalendarHorizonDays()).toBe(7);
    process.env.NASDAQ_CALENDAR_HORIZON_DAYS = "500";
    expect(nasdaqCalendarHorizonDays()).toBe(90);
    process.env.NASDAQ_CALENDAR_HORIZON_DAYS = "not-a-number";
    expect(nasdaqCalendarHorizonDays()).toBe(45);
  });

  // ── Pure parsing helpers ─────────────────────────────────────────────────────

  it("extractEarningsSymbols parses a real row shape and uppercases + hyphenates share classes", async () => {
    const { extractEarningsSymbols } = await import("../src/lib/nasdaq-calendar-provider");
    // Real shape observed live 2026-08-02 against api.nasdaq.com/api/calendar/earnings?date=...
    const payload = {
      data: {
        asOf: "Tue, Aug 4, 2026",
        headers: { time: "Time", symbol: "Symbol", name: "Company Name" },
        rows: [
          { time: "time-after-hours", symbol: "AMD", name: "Advanced Micro Devices, Inc." },
          { time: "time-pre-market", symbol: "brk.b", name: "Berkshire Hathaway" }
        ]
      }
    };
    const symbols = extractEarningsSymbols(payload);
    expect(symbols.has("AMD")).toBe(true);
    expect(symbols.has("BRK-B")).toBe(true);
    expect(symbols.has("BRK.B")).toBe(false);
  });

  it("extractEarningsSymbols returns an empty Set for every malformed shape actually observed live, never throws", async () => {
    const { extractEarningsSymbols } = await import("../src/lib/nasdaq-calendar-provider");
    // Confirmed live for a zero-report day (Sunday 2026-08-02): rows is `null`, not `[]`/absent.
    expect(extractEarningsSymbols({ data: { asOf: "Sun, Aug 2, 2026", headers: null, rows: null } })).toEqual(
      new Set()
    );
    expect(extractEarningsSymbols({ data: {} })).toEqual(new Set());
    expect(extractEarningsSymbols({})).toEqual(new Set());
    expect(extractEarningsSymbols(null)).toEqual(new Set());
    expect(extractEarningsSymbols(undefined)).toEqual(new Set());
    expect(extractEarningsSymbols({ data: { rows: "not-an-array" } })).toEqual(new Set());
    expect(extractEarningsSymbols({ data: { rows: [null, 42, { symbol: 7 }, { noSymbol: true }] } })).toEqual(
      new Set()
    );
  });

  it("dateKeyFromOffset formats UTC-midnight-anchored YYYY-MM-DD keys", async () => {
    const { dateKeyFromOffset } = await import("../src/lib/nasdaq-calendar-provider");
    const now = Date.parse("2026-08-04T15:30:00Z");
    expect(dateKeyFromOffset(now, 0)).toBe("2026-08-04");
    expect(dateKeyFromOffset(now, 1)).toBe("2026-08-05");
    expect(dateKeyFromOffset(now, 30)).toBe("2026-09-03");
  });

  // ── enrich() wiring ──────────────────────────────────────────────────────────

  /** Stubs global.fetch keyed by the `date=` query param on the earnings-calendar URL. `byDate`
   *  maps a dateKey -> an array of live-shaped rows, an HTTP status number, or an Error to throw
   *  (simulating a transport failure). Any date not in the map returns the real "no reports"
   *  shape (`rows: null`) rather than a fabricated non-empty result. */
  function stubEarningsByDate(byDate: Record<string, Array<{ symbol: string }> | number | Error>) {
    const requested: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      const match = /date=(\d{4}-\d{2}-\d{2})/.exec(url);
      const dateKey = match?.[1] ?? "";
      requested.push(dateKey);
      const value = byDate[dateKey];
      if (value instanceof Error) throw value;
      if (typeof value === "number") return new Response("", { status: value });
      const rows = value ?? null;
      return new Response(JSON.stringify({ data: { asOf: dateKey, headers: null, rows } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, requested };
  }

  it("finds the nearest future earnings date across the horizon and reports the correct day offset", async () => {
    const { NasdaqCalendarEnrichmentProvider, dateKeyFromOffset } = await import(
      "../src/lib/nasdaq-calendar-provider"
    );
    const now = Date.parse("2026-08-03T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    process.env.NASDAQ_CALENDAR_HORIZON_DAYS = "10";

    const day2 = dateKeyFromOffset(now, 2);
    stubEarningsByDate({ [day2]: [{ symbol: "AMD" }] });

    const provider = new NasdaqCalendarEnrichmentProvider();
    const out = await provider.enrich(["AMD"]);
    expect(out.AMD.daysToEarnings).toBe(2);
    vi.useRealTimers();
  });

  it("returns {} (no daysToEarnings) for a symbol with no reported date within the horizon — never a guess", async () => {
    const { NasdaqCalendarEnrichmentProvider } = await import("../src/lib/nasdaq-calendar-provider");
    const now = Date.parse("2026-08-03T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    process.env.NASDAQ_CALENDAR_HORIZON_DAYS = "7";

    stubEarningsByDate({}); // every date in range resolves to the real "no reports" shape

    const provider = new NasdaqCalendarEnrichmentProvider();
    const out = await provider.enrich(["ZZZZ"]);
    expect(out.ZZZZ).toEqual({});
    expect(out.ZZZZ.daysToEarnings).toBeUndefined();
    vi.useRealTimers();
  });

  it("never throws when a date's fetch fails, and still finds a later symbol's match on a good day", async () => {
    const { NasdaqCalendarEnrichmentProvider, dateKeyFromOffset } = await import(
      "../src/lib/nasdaq-calendar-provider"
    );
    const now = Date.parse("2026-08-03T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    process.env.NASDAQ_CALENDAR_HORIZON_DAYS = "10";

    const day0 = dateKeyFromOffset(now, 0);
    const day1 = dateKeyFromOffset(now, 1);
    stubEarningsByDate({
      [day0]: 500, // HTTP failure on the nearest day — must not throw or block the batch
      [day1]: [{ symbol: "MSFT" }]
    });

    const provider = new NasdaqCalendarEnrichmentProvider();
    const out = await provider.enrich(["MSFT"]);
    expect(out.MSFT.daysToEarnings).toBe(1);
    vi.useRealTimers();
  });

  it("caches a date's result and does not refetch within the TTL", async () => {
    const { NasdaqCalendarEnrichmentProvider, dateKeyFromOffset } = await import(
      "../src/lib/nasdaq-calendar-provider"
    );
    const now = Date.parse("2026-08-03T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    process.env.NASDAQ_CALENDAR_HORIZON_DAYS = "3";

    const day1 = dateKeyFromOffset(now, 1);
    const { fetchMock } = stubEarningsByDate({ [day1]: [{ symbol: "NVDA" }] });

    const provider = new NasdaqCalendarEnrichmentProvider();
    await provider.enrich(["NVDA"]);
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await provider.enrich(["NVDA"]);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // served entirely from the day-cache
    vi.useRealTimers();
  });

  it("retries a failed date after its (short) negative-cache TTL elapses", async () => {
    const { NasdaqCalendarEnrichmentProvider, dateKeyFromOffset } = await import(
      "../src/lib/nasdaq-calendar-provider"
    );
    process.env.NASDAQ_CALENDAR_HORIZON_DAYS = "1";
    // Real timers: keep the negative TTL long enough that the "immediate" re-query below still
    // lands inside the window even when the first enrich() is slow under a full suite (10ms was
    // too tight — first enrich alone can exceed it, so the second call always refetched).
    process.env.NASDAQ_CALENDAR_NEGATIVE_CACHE_TTL_MS = "500";

    const now = Date.now();
    const day0 = dateKeyFromOffset(now, 0);
    const { fetchMock } = stubEarningsByDate({ [day0]: new Error("network down") });

    const provider = new NasdaqCalendarEnrichmentProvider();
    const first = await provider.enrich(["TSLA"]);
    expect(first.TSLA).toEqual({});
    const callsAfterFirst = fetchMock.mock.calls.length;

    // Immediately re-querying stays within the negative TTL — no refetch yet.
    await provider.enrich(["TSLA"]);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);

    await new Promise((resolve) => setTimeout(resolve, 600));
    await provider.enrich(["TSLA"]);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("skips a symbol already covered by an earlier cascade provider for daysToEarnings", async () => {
    const { NasdaqCalendarEnrichmentProvider, dateKeyFromOffset } = await import(
      "../src/lib/nasdaq-calendar-provider"
    );
    const now = Date.parse("2026-08-03T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    process.env.NASDAQ_CALENDAR_HORIZON_DAYS = "3";

    const day0 = dateKeyFromOffset(now, 0);
    const { fetchMock } = stubEarningsByDate({ [day0]: [{ symbol: "GOOGL" }] });

    const provider = new NasdaqCalendarEnrichmentProvider();
    const out = await provider.enrich(["GOOGL"], {
      coveredFields: { GOOGL: new Set(["daysToEarnings"]) }
    });
    expect(out.GOOGL).toEqual({});
    expect(fetchMock.mock.calls.length).toBe(0); // never hit the network for an already-covered field
    vi.useRealTimers();
  });

  it("is a no-op (no network calls) when disabled via env", async () => {
    const { NasdaqCalendarEnrichmentProvider } = await import("../src/lib/nasdaq-calendar-provider");
    process.env.NASDAQ_CALENDAR_ENRICHMENT_ENABLED = "false";
    const { fetchMock } = stubEarningsByDate({});
    const provider = new NasdaqCalendarEnrichmentProvider();
    const out = await provider.enrich(["AAPL"]);
    expect(out).toEqual({});
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("returns {} for an empty or all-blank symbol list without touching the network", async () => {
    const { NasdaqCalendarEnrichmentProvider } = await import("../src/lib/nasdaq-calendar-provider");
    const { fetchMock } = stubEarningsByDate({});
    const provider = new NasdaqCalendarEnrichmentProvider();
    expect(await provider.enrich([])).toEqual({});
    expect(await provider.enrich(["", "  "])).toEqual({});
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("normalizes/dedupes requested symbols (whitespace, case, repeats)", async () => {
    const { NasdaqCalendarEnrichmentProvider, dateKeyFromOffset } = await import(
      "../src/lib/nasdaq-calendar-provider"
    );
    const now = Date.parse("2026-08-03T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    process.env.NASDAQ_CALENDAR_HORIZON_DAYS = "2";

    const day0 = dateKeyFromOffset(now, 0);
    stubEarningsByDate({ [day0]: [{ symbol: "AAPL" }] });

    const provider = new NasdaqCalendarEnrichmentProvider();
    const out = await provider.enrich([" aapl ", "AAPL", "aapl"]);
    expect(Object.keys(out)).toEqual(["AAPL"]);
    expect(out.AAPL.daysToEarnings).toBe(0);
    vi.useRealTimers();
  });
});
