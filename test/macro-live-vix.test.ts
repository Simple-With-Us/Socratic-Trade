/**
 * macro-live-vix.test.ts
 *
 * Covers the live ^VIX overlay (composite review D/high/S: "Split VIX/vol gauges off the 24h
 * macro cache"). Before this, the volatility panic brake and the regime-flip detector both read
 * `fetchMacroData`, which is cached 24h — on a crash day the brake/flip detector could be reading
 * a VIX reading up to a day stale. `fetchLiveVix`/`fetchMacroDataWithLiveVix` add a SEPARATE,
 * short-TTL (10 min) cache entry sourced from the same key-free Yahoo ^VIX chart endpoint the
 * no-FRED fallback already uses, so callers get a materially fresher VIX without a new upstream
 * dependency.
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-macro-live-vix-${randomUUID()}.db`)}`;
});

/** Stub global fetch: FRED calls (api.stlouisfed.org) return a constant reading; the Yahoo ^VIX
 *  chart call (query1.finance.yahoo.com) returns the given VIX close (or fails when null); the
 *  Cboe history CSV (cdn-api.cboe.com) and delayed JSON (cdn.cboe.com) behave likewise.
 *  Any unlisted host 404s — so a source left unspecified is simply "down" for that test. */
function stubFetch(opts: {
  fredValue?: string;
  yahooVix?: number | null;
  cboeVix?: number | null;
  cboeHistoryVix?: number | null;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("VIX_History") || url.includes("cdn-api.cboe.com")) {
        const vix =
          opts.cboeHistoryVix !== undefined
            ? opts.cboeHistoryVix
            : opts.cboeVix !== undefined
              ? opts.cboeVix
              : opts.yahooVix;
        if (vix === null || vix === undefined) {
          return { ok: false, status: 500, text: async () => "", json: async () => ({}) };
        }
        return {
          ok: true,
          text: async () => `DATE,CLOSE\n2026-01-02,${vix}\n`,
          json: async () => ({})
        };
      }
      if (url.includes("cdn.cboe.com")) {
        const vix = opts.cboeVix !== undefined ? opts.cboeVix : opts.yahooVix;
        if (vix === null || vix === undefined) {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        return { ok: true, json: async () => ({ data: { current_price: vix } }) };
      }
      if (url.includes("query1.finance.yahoo.com")) {
        if (opts.yahooVix === null || opts.yahooVix === undefined) {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        return {
          ok: true,
          json: async () => ({
            chart: { result: [{ indicators: { quote: [{ close: [opts.yahooVix] }] } }] }
          })
        };
      }
      if (url.includes("api.stlouisfed.org")) {
        return { ok: true, json: async () => ({ observations: [{ value: opts.fredValue ?? "4.50" }] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    })
  );
}

/** Reset the shared circuit breaker and purge the VIX lanes' health rows so one test's recorded
 *  failures can never trip (or hold open) a breaker lane in the next test. */
async function resetVixLaneState() {
  const { resetApiCircuitBreaker } = await import("../src/lib/api-circuit-breaker");
  resetApiCircuitBreaker();
  const { getDb } = await import("../src/lib/db");
  getDb()
    .prepare(
      "DELETE FROM api_health_log WHERE service IN ('vix-yahoo', 'vix-cboe', 'vix-cboe-history', 'vix-fred')"
    )
    .run();
}

describe("fetchLiveVix", () => {
  beforeEach(async () => {
    const { clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();
    await resetVixLaneState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a live VIX reading with a real asOf on success", async () => {
    stubFetch({ yahooVix: 22.5 });
    const { fetchLiveVix } = await import("../src/lib/macro");
    const result = await fetchLiveVix();
    expect(result.vix).toBe(22.5);
    expect(result.asOf).not.toBeNull();
  });

  it("returns vix:null and asOf:null on fetch failure (never fabricates a reading)", async () => {
    stubFetch({ yahooVix: null });
    const { fetchLiveVix } = await import("../src/lib/macro");
    const result = await fetchLiveVix();
    expect(result.vix).toBeNull();
    expect(result.asOf).toBeNull();
  });

  it("caches the live reading for repeat calls within the short TTL (single upstream call)", async () => {
    stubFetch({ yahooVix: 18.0 });
    const { fetchLiveVix } = await import("../src/lib/macro");
    const now = Date.now();
    const first = await fetchLiveVix(now);
    const second = await fetchLiveVix(now + 60_000); // 1 min later — still inside the 10 min TTL
    expect(first.vix).toBe(18.0);
    expect(second.vix).toBe(18.0);
    expect(second.asOf).toBe(first.asOf); // served from cache, same stamp
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refetches after the short TTL expires", async () => {
    stubFetch({ yahooVix: 18.0 });
    const { fetchLiveVix } = await import("../src/lib/macro");
    const now = Date.now();
    await fetchLiveVix(now);
    await fetchLiveVix(now + 11 * 60_000); // past the 10 min TTL
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("fetchMacroDataWithLiveVix", () => {
  beforeEach(async () => {
    delete process.env.FRED_API_KEY;
    const { clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();
    await resetVixLaneState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FRED_API_KEY;
  });

  it("overlays the live VIX onto the cached macro snapshot, stamping vixAsOf", async () => {
    process.env.FRED_API_KEY = "env-key-live-vix-test";
    stubFetch({ fredValue: "5.00", yahooVix: 31.25 });

    const { fetchMacroDataWithLiveVix, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();
    const result = await fetchMacroDataWithLiveVix("user-live-vix");

    expect(result.vix).toBe("31.25");
    expect(result.vixAsOf).toBeDefined();
    // Everything else still comes from the (mocked) FRED suite.
    expect(result.fedFundsRate).toBe("5.00%");
  });

  it("overlays live FRED VIXCLS when the keyless cascade reaches FRED after CSV/Cboe fail", async () => {
    process.env.FRED_API_KEY = "env-key-live-vix-fallback";
    stubFetch({ fredValue: "5.00", yahooVix: null, cboeHistoryVix: null, cboeVix: null });

    const { fetchMacroDataWithLiveVix, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();
    const result = await fetchMacroDataWithLiveVix("user-live-vix-2");

    expect(result.vix).toBe("5.00");
    expect(result.vixAsOf).toBeDefined();
  });

  it("promotes an 'unavailable' macro snapshot to live when the VIX overlay succeeds", async () => {
    // No FRED key at all -> fetchMacroData would normally fall back to fetchVixOnlyFallback,
    // which ALSO calls fetchVixFromYahoo. Simulate the (rarer) case where the light-macro path's
    // own VIX attempt failed (asOf stays "unavailable") but a subsequent live-VIX call succeeds.
    delete process.env.FRED_API_KEY;
    stubFetch({ yahooVix: null }); // first pass: the light-macro fallback's VIX attempt fails too

    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();
    const unavailable = await fetchMacroData("user-live-vix-3");
    expect(unavailable.asOf).toBe("unavailable");

    // The failed first pass recorded lane failures; clear the breaker/lane history to simulate the
    // recovery probe AFTER the cooldown has elapsed (otherwise the tripped lanes are skipped).
    await resetVixLaneState();

    // Now the live path succeeds on a later call.
    stubFetch({ yahooVix: 27.0 });
    const { fetchMacroDataWithLiveVix } = await import("../src/lib/macro");
    const overlaid = await fetchMacroDataWithLiveVix("user-live-vix-3");
    expect(overlaid.vix).toBe("27.00");
    expect(overlaid.asOf).not.toBe("unavailable");
    expect(overlaid.vixAsOf).toBeDefined();
  });
});

describe("keyless VIX cascade (Cboe history -> FRED -> Cboe JSON -> Yahoo)", () => {
  beforeEach(async () => {
    delete process.env.FRED_API_KEY;
    const { clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();
    await resetVixLaneState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves Cboe VIX_History.csv first, falling back to Yahoo when history and delayed JSON fail", async () => {
    stubFetch({ cboeHistoryVix: null, cboeVix: null, yahooVix: 27.5 });
    const { fetchLiveVix } = await import("../src/lib/macro");
    const result = await fetchLiveVix();
    expect(result.vix).toBe(27.5);
    expect(result.asOf).not.toBeNull();
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("VIX_History") || u.includes("cdn-api.cboe.com"))).toBe(true);
    expect(urls.some((u) => u.includes("query1.finance.yahoo.com"))).toBe(true);
  });

  it("with no FRED key, a Cboe history VIX still yields a timestamped macro snapshot (not 'unavailable')", async () => {
    stubFetch({ yahooVix: null, cboeVix: null, cboeHistoryVix: 22.0 });
    const { fetchMacroData } = await import("../src/lib/macro");
    const macro = await fetchMacroData("user-cascade-cboe");
    expect(macro.vix).toBe("22.00");
    expect(macro.asOf).not.toBe("unavailable");
    expect(macro.fredSourced).toBe(false);
  });

  it("all sources dead -> honest 'unavailable' (never a fabricated VIX)", async () => {
    stubFetch({ yahooVix: null, cboeVix: null, cboeHistoryVix: null });
    const { fetchMacroData, fetchLiveVix } = await import("../src/lib/macro");
    const macro = await fetchMacroData("user-cascade-dead");
    expect(macro.asOf).toBe("unavailable");
    expect(macro.vix).toBe("");
    const live = await fetchLiveVix();
    expect(live.vix).toBeNull();
    expect(live.asOf).toBeNull();
  });

  it("trips the per-lane circuit breaker after 5 hard consecutive failures (not soft yellow alone)", async () => {
    stubFetch({ yahooVix: null, cboeVix: null, cboeHistoryVix: null });
    const { fetchLiveVix } = await import("../src/lib/macro");
    const { getLaneHealth, HEALTH_REASON_CONSECUTIVE_FAILURES } = await import("../src/lib/db-health");
    const mock = fetch as unknown as ReturnType<typeof vi.fn>;

    // Soft yellow ("active this hour, no success") after a single cold failure must NOT open the
    // transport breaker — that matches applyCircuitBreaker / expected-limit soft classification.
    // Hard consecutive-failures (5 non-soft fails) still do, so a truly dead endpoint is probed
    // on a backoff cadence rather than hammered every tick.
    const base = Date.now();
    await fetchLiveVix(base);
    const afterFirst = mock.mock.calls.length;
    expect(afterFirst).toBeGreaterThanOrEqual(2);
    // One fail each lane → soft yellow possible, but no hard consecutive-failures yet.
    for (const lane of ["vix-yahoo", "vix-cboe-history", "vix-cboe"]) {
      const h = getLaneHealth(lane, null);
      expect(h.stoppedWorking).toBe(true);
      expect(h.reason).not.toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
    }
    // Still allowed through (no circuit skip on soft yellow alone).
    await fetchLiveVix(base + 11 * 60_000);
    expect(mock.mock.calls.length).toBeGreaterThan(afterFirst);

    // Seed 5 hard failures so the transport breaker trips.
    const { logApiHealth } = await import("../src/lib/db-health");
    for (const lane of ["vix-yahoo", "vix-cboe-history", "vix-cboe"]) {
      for (let i = 0; i < 5; i++) {
        logApiHealth({ service: lane, ok: false, errorText: "HTTP 500" });
      }
      expect(getLaneHealth(lane, null).reason).toBe(HEALTH_REASON_CONSECUTIVE_FAILURES);
    }
    const before = mock.mock.calls.length;
    await fetchLiveVix(base + 22 * 60_000);
    await fetchLiveVix(base + 33 * 60_000);
    // Both ticks short-circuit — no additional upstream calls while the hard circuit is open.
    expect(mock.mock.calls.length).toBe(before);
  });
});

describe("fetchVixLane HTTP 429 hardening (Yahoo/Cboe bot-rate-limiting)", () => {
  beforeEach(async () => {
    delete process.env.FRED_API_KEY;
    const { clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();
    await resetVixLaneState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries a Yahoo HTTP 429 with exponential backoff before succeeding, instead of failing the lane after one try", async () => {
    let yahooCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("cdn-api.cboe.com") || url.includes("cdn.cboe.com")) {
          return { ok: false, status: 500, text: async () => "", json: async () => ({}) };
        }
        if (url.includes("query1.finance.yahoo.com")) {
          yahooCalls++;
          if (yahooCalls < 3) return { ok: false, status: 429, json: async () => ({}) };
          return {
            ok: true,
            json: async () => ({ chart: { result: [{ indicators: { quote: [{ close: [24.5] }] } }] } })
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      })
    );

    const { fetchLiveVix } = await import("../src/lib/macro");
    const result = await fetchLiveVix();
    expect(result.vix).toBe(24.5);
    expect(yahooCalls).toBe(3); // two 429s, then a 200 on the third attempt

    // The lane's health reflects the eventual SUCCESS, not the transient 429s along the way —
    // a lane that recovers within its own retry budget must not look "stopped working".
    const { getLaneHealth } = await import("../src/lib/db-health");
    expect(getLaneHealth("vix-yahoo", null).stoppedWorking).toBe(false);
  });

  it("gives up and returns null (never fabricates) after exhausting Yahoo 429 retries", async () => {
    let yahooCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("cdn-api.cboe.com") || url.includes("cdn.cboe.com")) {
          return { ok: false, status: 500, text: async () => "", json: async () => ({}) };
        }
        if (url.includes("query1.finance.yahoo.com")) {
          yahooCalls++;
          return { ok: false, status: 429, json: async () => ({}) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      })
    );

    const { fetchLiveVix } = await import("../src/lib/macro");
    const result = await fetchLiveVix();
    expect(result.vix).toBeNull();
    expect(result.asOf).toBeNull();
    expect(yahooCalls).toBe(4); // 1 initial attempt + 3 retries, all 429 — then gives up honestly
  });
});
