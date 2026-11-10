/**
 * cache-provenance.test.ts
 *
 * Verifies that process-global provider caches scope their entries correctly:
 *   - env/free-source data → shared key (all users benefit, no licensing issue)
 *   - user-keyed data → private per-user key (never leaked cross-user)
 *   - MARKET_DATA_SHARE_USER_KEYED_MACRO opt-in flag → allows cross-user sharing
 *
 * Covers: macro.ts, macro-history.ts (the two highest-priority caches per spec).
 * The enrichment cache (data-providers.ts) already has the pattern implemented;
 * its scoping helpers are exercised here via direct import.
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Each test file gets its own isolated SQLite db.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-cache-provenance-${randomUUID()}.db`)}`;
});

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Build a MacroData-shaped FRED response that the fetch mock will return. */
function mockFredObs(value: string) {
  return JSON.stringify({ observations: [{ value }] });
}

/** Stub global fetch so FRED calls return a constant value without hitting the network. */
function stubFredFetch(value: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => JSON.parse(mockFredObs(value))
    }))
  );
}

// ─── macro.ts cache-provenance ────────────────────────────────────────────────

describe("macro.ts cache-provenance", () => {
  beforeEach(async () => {
    // Reset env keys and caches before every test.
    delete process.env.FRED_API_KEY;
    delete process.env.MARKET_DATA_SHARE_USER_KEYED_MACRO;
    const { clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();
    const { clearBlsMacroCacheForTests } = await import("../src/lib/market-signals/bls");
    clearBlsMacroCacheForTests();
    // The keyless VIX cascade (Yahoo/Cboe/Stooq) records per-lane health and runs through the
    // shared circuit breaker: a previous test's stubbed failures would otherwise trip the lanes
    // and silently skip the sources this test expects to be called.
    const { resetApiCircuitBreaker } = await import("../src/lib/api-circuit-breaker");
    resetApiCircuitBreaker();
    const { getDb } = await import("../src/lib/db");
    getDb()
      .prepare("DELETE FROM api_health_log WHERE service IN ('vix-yahoo', 'vix-cboe', 'vix-stooq')")
      .run();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Reset opt-in flag.
    delete process.env.MARKET_DATA_SHARE_USER_KEYED_MACRO;
  });

  it("env-key result is stored under a shared entry and reused across different userIds", async () => {
    // Arrange: FRED key is in env (source === "env").
    process.env.FRED_API_KEY = "env-key-abc";
    stubFredFetch("4.50"); // all FRED series return "4.50" — we just need valid data

    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();

    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`;

    // Act: two different users fetch macro data.
    const resultA = await fetchMacroData(userA);
    // Second fetch should come from the shared cache — no additional network calls.
    const fetchCallsAfterA = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const resultB = await fetchMacroData(userB);
    const fetchCallsAfterB = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    // Assert: both got live data (not "unavailable"), and the second fetch did not
    // make any new network calls (served from the shared cache).
    expect(resultA.asOf).not.toBe("unavailable");
    expect(resultB.asOf).not.toBe("unavailable");
    // A real FRED fetch marks the suite as sourced (dashboard honesty flag).
    expect(resultA.fredSourced).toBe(true);
    expect(resultB.fredSourced).toBe(true);
    // Both should get the exact same object (same data).
    expect(resultB.fedFundsRate).toBe(resultA.fedFundsRate);
    // No additional FRED network calls after userA's fetch populated the shared cache.
    expect(fetchCallsAfterB).toBe(fetchCallsAfterA);
  });

  it("user-keyed result is NOT returned for a different userId (no cross-user leak)", async () => {
    // Arrange: no env key; userA has stored their own FRED key.
    delete process.env.FRED_API_KEY;
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");

    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`; // no stored key

    upsertUserApiKey(userA, "fred", "user-fred-key-xyz");
    clearMacroCacheForTests();

    stubFredFetch("3.75");

    // Act: userA fetches (user-keyed → private cache entry).
    const resultA = await fetchMacroData(userA);
    const callsAfterA = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    // userB fetches without any FRED key — should get the "unavailable" default,
    // NOT userA's private result. Stub fetch to fail so that fetchVixFromYahoo()
    // also returns null (otherwise a live Yahoo Finance call can succeed in CI
    // and set asOf to today's date instead of "unavailable").
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in test")));
    const resultB = await fetchMacroData(userB);

    // Assert: userA got live data; userB got the no-key fallback.
    expect(resultA.asOf).not.toBe("unavailable");
    expect(resultB.asOf).toBe("unavailable");
    // userA's network calls happened; userB got a different (default) result.
    expect(callsAfterA).toBeGreaterThan(0);
  });

  it("opt-in flag MARKET_DATA_SHARE_USER_KEYED_MACRO=true promotes user-keyed result to shared", async () => {
    // Arrange: no env key; userA has stored FRED key; opt-in flag is ON.
    delete process.env.FRED_API_KEY;
    process.env.MARKET_DATA_SHARE_USER_KEYED_MACRO = "true";

    const { upsertUserApiKey } = await import("../src/lib/db");
    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");

    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`; // no stored key

    upsertUserApiKey(userA, "fred", "user-fred-key-shared");
    clearMacroCacheForTests();

    stubFredFetch("5.00");

    // Act: userA fetches (user-keyed but opt-in → shared entry).
    const resultA = await fetchMacroData(userA);
    // userB fetches — should now get the shared cache result (no new network calls).
    const callsAfterA = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const resultB = await fetchMacroData(userB);
    const callsAfterB = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    // Assert: both got live data; no extra network calls after A's fetch.
    expect(resultA.asOf).not.toBe("unavailable");
    expect(resultB.asOf).not.toBe("unavailable");
    expect(callsAfterB).toBe(callsAfterA); // served from shared cache
  });

  it("no-key path tries Yahoo VIX; falls back to asOf=unavailable when Yahoo also fails", async () => {
    delete process.env.FRED_API_KEY;
    // Stub fetch to simulate a failing Yahoo response (network error) — this also fails the
    // keyless Treasury yield-curve fallback, since it shares the same stubbed fetch.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();

    const result = await fetchMacroData(undefined);
    expect(result.asOf).toBe("unavailable");
    // Nothing was sourced — the flags say so explicitly.
    expect(result.fredSourced).toBe(false);
    expect(result.treasurySourced).toBe(false);
    expect(result.dgs3moTreasury).toBe("");
    expect(result.dgs10Treasury).toBe("");
  });

  it("no-key path sources the yield curve keylessly from Treasury.gov when VIX also fails", async () => {
    delete process.env.FRED_API_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("home.treasury.gov")) {
          return {
            ok: true,
            text: async () =>
              `<feed><entry><content type="application/xml"><m:properties>` +
              `<d:NEW_DATE m:type="Edm.DateTime">2026-07-31T00:00:00</d:NEW_DATE>` +
              `<d:BC_3MONTH m:type="Edm.Double">3.90</d:BC_3MONTH>` +
              `<d:BC_2YEAR m:type="Edm.Double">4.20</d:BC_2YEAR>` +
              `<d:BC_10YEAR m:type="Edm.Double">4.55</d:BC_10YEAR>` +
              `</m:properties></content></entry></feed>`
          };
        }
        // Every VIX lane (Cboe + Yahoo) fails.
        throw new Error("Network error");
      })
    );

    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();

    const result = await fetchMacroData(undefined);
    expect(result.asOf).not.toBe("unavailable");
    expect(result.dgs3moTreasury).toBe("3.90%");
    expect(result.dgs2Treasury).toBe("4.20%");
    expect(result.dgs10Treasury).toBe("4.55%");
    expect(result.treasurySourced).toBe(true);
    // The VIX lane genuinely failed — never fabricated, even though the curve is real.
    expect(result.vix).toBe("");
    // Still not a full FRED fetch — every non-Treasury FRED field stays blank.
    expect(result.fredSourced).toBe(false);
    expect(result.fedFundsRate).toBe("");
  });

  it("no-key path sources BOTH a live VIX and the Treasury yield curve when both keyless lanes succeed", async () => {
    delete process.env.FRED_API_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("home.treasury.gov")) {
          return {
            ok: true,
            text: async () =>
              `<feed><entry><content type="application/xml"><m:properties>` +
              `<d:NEW_DATE m:type="Edm.DateTime">2026-07-31T00:00:00</d:NEW_DATE>` +
              `<d:BC_10YEAR m:type="Edm.Double">4.55</d:BC_10YEAR>` +
              `</m:properties></content></entry></feed>`
          };
        }
        return {
          ok: true,
          json: async () => ({ chart: { result: [{ indicators: { quote: [{ close: [22.5] }] } }] } })
        };
      })
    );

    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();

    const result = await fetchMacroData(undefined);
    expect(parseFloat(result.vix)).toBeCloseTo(22.5, 1);
    expect(result.dgs10Treasury).toBe("4.55%");
    expect(result.treasurySourced).toBe(true);
    expect(result.fredSourced).toBe(false);
  });

  const blsLiveShapedResponse = {
    status: "REQUEST_SUCCEEDED",
    responseTime: 100,
    message: [],
    Results: {
      series: [
        {
          seriesID: "CUUR0000SA0",
          data: [
            { year: "2026", period: "M06", periodName: "June", latest: "true", value: "333.952", footnotes: [{}] },
            { year: "2025", period: "M06", periodName: "June", value: "322.561", footnotes: [{}] }
          ]
        },
        {
          seriesID: "LNS14000000",
          data: [{ year: "2026", period: "M06", periodName: "June", latest: "true", value: "4.20", footnotes: [{}] }]
        },
        {
          seriesID: "CES0000000001",
          data: [
            { year: "2026", period: "M06", periodName: "June", latest: "true", value: "158984", footnotes: [{}] },
            { year: "2026", period: "M05", periodName: "May", value: "158927", footnotes: [{}] }
          ]
        }
      ]
    }
  };

  it("no-key path sources CPI/unemployment/payrolls keylessly from BLS when VIX and Treasury both fail", async () => {
    delete process.env.FRED_API_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("api.bls.gov")) {
          return { ok: true, json: async () => blsLiveShapedResponse };
        }
        // Every VIX lane (Cboe + Yahoo) and the Treasury yield-curve lane all fail.
        throw new Error("Network error");
      })
    );

    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");
    const { clearBlsMacroCacheForTests } = await import("../src/lib/market-signals/bls");
    clearMacroCacheForTests();
    clearBlsMacroCacheForTests();

    const result = await fetchMacroData(undefined);
    expect(result.asOf).not.toBe("unavailable");
    expect(result.cpiInflation).toBe("3.53%"); // (333.952-322.561)/322.561 * 100, YoY
    expect(result.unemploymentRate).toBe("4.20%");
    expect(result.nonfarmPayrollsChangeK).toBe("+57K"); // 158984-158927
    expect(result.blsSourced).toBe(true);
    // Neither VIX nor Treasury actually succeeded — never fabricated, even though BLS is real.
    expect(result.vix).toBe("");
    expect(result.dgs10Treasury).toBe("");
    expect(result.treasurySourced).toBe(false);
    // Still not a full FRED fetch — every non-BLS FRED field stays blank.
    expect(result.fredSourced).toBe(false);
    expect(result.fedFundsRate).toBe("");
  });

  it("no-key path sources VIX, Treasury, AND BLS together when all three keyless lanes succeed", async () => {
    delete process.env.FRED_API_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("api.bls.gov")) return { ok: true, json: async () => blsLiveShapedResponse };
        if (url.includes("home.treasury.gov")) {
          return {
            ok: true,
            text: async () =>
              `<feed><entry><content type="application/xml"><m:properties>` +
              `<d:NEW_DATE m:type="Edm.DateTime">2026-07-31T00:00:00</d:NEW_DATE>` +
              `<d:BC_10YEAR m:type="Edm.Double">4.55</d:BC_10YEAR>` +
              `</m:properties></content></entry></feed>`
          };
        }
        return {
          ok: true,
          json: async () => ({ chart: { result: [{ indicators: { quote: [{ close: [22.5] }] } }] } })
        };
      })
    );

    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");
    const { clearBlsMacroCacheForTests } = await import("../src/lib/market-signals/bls");
    clearMacroCacheForTests();
    clearBlsMacroCacheForTests();

    const result = await fetchMacroData(undefined);
    expect(parseFloat(result.vix)).toBeCloseTo(22.5, 1);
    expect(result.dgs10Treasury).toBe("4.55%");
    expect(result.treasurySourced).toBe(true);
    expect(result.unemploymentRate).toBe("4.20%");
    expect(result.blsSourced).toBe(true);
    expect(result.fredSourced).toBe(false);
  });

  it("no-key path returns a live regime when Yahoo VIX fetch succeeds", async () => {
    delete process.env.FRED_API_KEY;
    // Stub fetch to return a valid Yahoo VIX chart response with VIX = 22.5.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        chart: { result: [{ indicators: { quote: [{ close: [21.0, 22.5] }] } }] }
      })
    }));

    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();

    const result = await fetchMacroData(undefined);
    expect(result.asOf).not.toBe("unavailable");
    expect(parseFloat(result.vix)).toBeCloseTo(22.5, 1);
    // The VIX is live but no FRED fetch ran — the flag is false and every FRED field is
    // blanked to "" (em dash on the console, dropped from the prompt), never a placeholder.
    expect(result.fredSourced).toBe(false);
    expect(result.fedFundsRate).toBe("");
    expect(result.dgs10Treasury).toBe("");
    expect(result.vix3m).toBe("");
  });

  it("configured-but-failing FRED key (every series non-OK) is NOT marked sourced; falls back to live VIX", async () => {
    // An invalid / rate-limited key makes every fetchFredSeries return undefined,
    // building an all-placeholder payload. That must take the same unsourced path
    // as the no-key case — never fredSourced: true.
    process.env.FRED_API_KEY = "invalid-or-rate-limited-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("stlouisfed.org")) {
          return { ok: false, status: 429, json: async () => ({}) }; // FRED rejects every series
        }
        // Yahoo ^VIX fallback succeeds.
        return {
          ok: true,
          json: async () => ({ chart: { result: [{ indicators: { quote: [{ close: [23.0] }] } }] } })
        };
      })
    );

    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();

    const result = await fetchMacroData(undefined);
    expect(result.fredSourced).toBe(false);
    expect(parseFloat(result.vix)).toBeCloseTo(23.0, 1); // live Yahoo reading, not the placeholder
    expect(result.asOf).not.toBe("unavailable");
    // FRED fields are blanked to "" (never placeholder constants) so nothing fabricated can
    // reach the regime classifier, the derived metrics, or the strategy prompt.
    expect(result.fedFundsRate).toBe("");
    expect(result.dgs10Treasury).toBe("");

    // The honest flag is what got CACHED — the 24h TTL cannot resurrect a false positive.
    const cached = await fetchMacroData(undefined);
    expect(cached.fredSourced).toBe(false);
  });

  it("configured-but-failing FRED key with Yahoo also down falls back to asOf=unavailable, unsourced", async () => {
    process.env.FRED_API_KEY = "invalid-or-rate-limited-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("stlouisfed.org")
          ? { ok: false, status: 403, json: async () => ({}) }
          : (() => {
              throw new Error("Yahoo down too");
            })()
      )
    );

    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();

    const result = await fetchMacroData(undefined);
    expect(result.asOf).toBe("unavailable");
    expect(result.fredSourced).toBe(false);
    // Fully unavailable — even the VIX is blank, not the old "15.00" placeholder.
    expect(result.vix).toBe("");
    expect(result.fedFundsRate).toBe("");
  });

  it("PARTIAL FRED fetch blanks only the failed series (empty string) and keeps the suite sourced", async () => {
    // One series (VIXCLS) fails while the rest succeed. The suite is still a real keyed fetch
    // (fredSourced true), but the failed field must be "" — never a DEFAULT_MACRO placeholder —
    // so the console blanks that single tile instead of showing a fabricated live reading.
    process.env.FRED_API_KEY = "env-key-partial";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("stlouisfed.org")) {
          if (u.includes("series_id=VIXCLS")) return { ok: false, status: 429, json: async () => ({}) };
          return { ok: true, json: async () => JSON.parse(mockFredObs("4.50")) };
        }
        // No Yahoo call is expected on a partial fetch (anyFredValue is true), but stub it safe.
        return { ok: true, json: async () => ({ chart: { result: [{ indicators: { quote: [{ close: [23.0] }] } }] } }) };
      })
    );

    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();

    const result = await fetchMacroData(undefined);
    expect(result.fredSourced).toBe(true); // a real keyed fetch DID run
    expect(result.vix).toBe(""); // the ONE failed series is blanked, not the "15.00" placeholder
    expect(result.vix).not.toBe("15.00");
    expect(result.fedFundsRate).toBe("4.50%"); // sourced fields stay real
    expect(result.asOf).not.toBe("unavailable");
  });

  it("a failed USER-key fetch does NOT poison the shared cache (env/other users still fetch fresh)", async () => {
    // userA's stored FRED key fails => VIX-only fallback. That fallback must be cached PRIVATE to
    // userA, not SHARED — otherwise the env-key path (and every other user) would read the blank
    // VIX-only payload for 24h before ever trying its own valid FRED fetch.
    delete process.env.FRED_API_KEY;
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();

    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`;
    upsertUserApiKey(userA, "fred", "user-fred-key-that-fails");

    // userA: FRED rejects every series; Yahoo VIX succeeds => VIX-only fallback (private scope).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("stlouisfed.org")
          ? { ok: false, status: 429, json: async () => ({}) }
          : { ok: true, json: async () => ({ chart: { result: [{ indicators: { quote: [{ close: [23.0] }] } }] } }) }
      )
    );
    const resultA = await fetchMacroData(userA);
    expect(resultA.fredSourced).toBe(false); // userA got the blank fallback

    // Now an env key is configured (shared scope) and FRED works. userB must fetch FRESH — the
    // shared cache was NOT poisoned by userA's private failure.
    process.env.FRED_API_KEY = "env-key-good";
    stubFredFetch("4.50");
    const resultB = await fetchMacroData(userB);
    expect(resultB.fredSourced).toBe(true);
    expect(resultB.fedFundsRate).toBe("4.50%");
  });
});

// ─── macro-history.ts cache-provenance ────────────────────────────────────────

describe("macro-history.ts cache-provenance", () => {
  beforeEach(async () => {
    delete process.env.FRED_API_KEY;
    delete process.env.MARKET_DATA_SHARE_USER_KEYED_MACRO_HISTORY;
    const { clearMacroHistoryCacheForTests } = await import("../src/lib/macro-history");
    clearMacroHistoryCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MARKET_DATA_SHARE_USER_KEYED_MACRO_HISTORY;
  });

  /** Stub fetch to return a valid FRED history response with N observations. */
  function stubFredHistoryFetch(points: number = 10) {
    const obs = Array.from({ length: points }, (_, i) => ({ value: String(i + 1) }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string) => ({
        ok: true,
        json: async () => ({ observations: obs })
      }))
    );
  }

  it("env-key history is stored in the shared cache and reused across users", async () => {
    process.env.FRED_API_KEY = "env-hist-key";
    stubFredHistoryFetch();

    const { fetchMacroHistory, clearMacroHistoryCacheForTests } = await import("../src/lib/macro-history");
    clearMacroHistoryCacheForTests();

    const now = Date.now();
    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`;

    const resultA = await fetchMacroHistory(now, userA);
    const callsAfterA = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const resultB = await fetchMacroHistory(now, userB);
    const callsAfterB = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    // Both get populated results.
    expect(Object.keys(resultA).length).toBeGreaterThan(0);
    expect(Object.keys(resultB).length).toBeGreaterThan(0);
    // No additional network calls after userA populated the shared cache.
    expect(callsAfterB).toBe(callsAfterA);
  });

  it("user-keyed history is NOT served to a different userId", async () => {
    delete process.env.FRED_API_KEY;
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { fetchMacroHistory, clearMacroHistoryCacheForTests } = await import("../src/lib/macro-history");

    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`;

    upsertUserApiKey(userA, "fred", "user-hist-key-private");
    clearMacroHistoryCacheForTests();

    stubFredHistoryFetch();
    const now = Date.now();

    // userA fetches — user-keyed → private cache.
    const resultA = await fetchMacroHistory(now, userA);

    // userB has no key → should get {} (no network calls, no cross-user data).
    vi.unstubAllGlobals();
    const resultB = await fetchMacroHistory(now, userB);

    expect(Object.keys(resultA).length).toBeGreaterThan(0);
    expect(Object.keys(resultB).length).toBe(0); // userB sees nothing
  });

  it("opt-in MARKET_DATA_SHARE_USER_KEYED_MACRO_HISTORY promotes user-keyed history to shared", async () => {
    delete process.env.FRED_API_KEY;
    process.env.MARKET_DATA_SHARE_USER_KEYED_MACRO_HISTORY = "1";

    const { upsertUserApiKey } = await import("../src/lib/db");
    const { fetchMacroHistory, clearMacroHistoryCacheForTests } = await import("../src/lib/macro-history");

    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`;

    upsertUserApiKey(userA, "fred", "user-hist-key-shared");
    clearMacroHistoryCacheForTests();

    stubFredHistoryFetch();
    const now = Date.now();

    const resultA = await fetchMacroHistory(now, userA);
    const callsAfterA = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const resultB = await fetchMacroHistory(now, userB);
    const callsAfterB = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(Object.keys(resultA).length).toBeGreaterThan(0);
    expect(Object.keys(resultB).length).toBeGreaterThan(0);
    // Served from the shared cache — no extra network calls.
    expect(callsAfterB).toBe(callsAfterA);
  });
});
