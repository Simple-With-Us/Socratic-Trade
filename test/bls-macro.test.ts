import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearBlsMacroCacheForTests,
  deriveBlsMacroSeries,
  fetchBlsMacroSeries,
  parseBlsTimeseriesResponse,
  resolveBlsApiKey
} from "../src/lib/market-signals/bls";

// Realistic row shapes below are trimmed from a real live 2026-08-02 POST to
// https://api.bls.gov/publicAPI/v2/timeseries/data/ for CUUR0000SA0 + LNS14000000 + CES0000000001,
// including the real "-" / footnoted gap BLS returned for 2025-10 (the 2025 lapse in appropriations).
function liveShapedResponse() {
  return {
    status: "REQUEST_SUCCEEDED",
    responseTime: 106,
    message: [],
    Results: {
      series: [
        {
          seriesID: "CUUR0000SA0",
          data: [
            { year: "2026", period: "M06", periodName: "June", latest: "true", value: "333.952", footnotes: [{}] },
            { year: "2026", period: "M05", periodName: "May", value: "335.123", footnotes: [{}] },
            { year: "2025", period: "M12", periodName: "December", value: "324.054", footnotes: [{}] },
            {
              year: "2025",
              period: "M10",
              periodName: "October",
              value: "-",
              footnotes: [{ code: "X", text: "Data unavailable due to the 2025 lapse in appropriations" }]
            },
            { year: "2025", period: "M06", periodName: "June", value: "322.561", footnotes: [{}] },
            { year: "2025", period: "M05", periodName: "May", value: "321.465", footnotes: [{}] }
          ]
        },
        {
          seriesID: "LNS14000000",
          data: [
            { year: "2026", period: "M06", periodName: "June", latest: "true", value: "4.2", footnotes: [{}] },
            { year: "2026", period: "M05", periodName: "May", value: "4.3", footnotes: [{}] },
            {
              year: "2025",
              period: "M10",
              periodName: "October",
              value: "-",
              footnotes: [{ code: "9", text: "Data unavailable due to the 2025 lapse in appropriations." }]
            },
            { year: "2025", period: "M06", periodName: "June", value: "4.1", footnotes: [{}] }
          ]
        },
        {
          seriesID: "CES0000000001",
          data: [
            {
              year: "2026",
              period: "M06",
              periodName: "June",
              latest: "true",
              value: "158984",
              footnotes: [{ code: "P", text: "preliminary" }]
            },
            { year: "2026", period: "M05", periodName: "May", value: "158927", footnotes: [{ code: "P", text: "preliminary" }] },
            { year: "2025", period: "M10", periodName: "October", value: "158408", footnotes: [{}] }
          ]
        }
      ]
    }
  };
}

describe("parseBlsTimeseriesResponse", () => {
  it("parses a real-shaped multi-series response, dropping footnoted gap rows", () => {
    const parsed = parseBlsTimeseriesResponse(liveShapedResponse());
    expect(parsed["CUUR0000SA0"]).toEqual([
      { year: 2025, month: 5, value: 321.465 },
      { year: 2025, month: 6, value: 322.561 },
      { year: 2025, month: 12, value: 324.054 },
      { year: 2026, month: 5, value: 335.123 },
      { year: 2026, month: 6, value: 333.952 }
    ]);
    expect(parsed["LNS14000000"]).toEqual([
      { year: 2025, month: 6, value: 4.1 },
      { year: 2026, month: 5, value: 4.3 },
      { year: 2026, month: 6, value: 4.2 }
    ]);
    expect(parsed["CES0000000001"]).toEqual([
      { year: 2025, month: 10, value: 158408 },
      { year: 2026, month: 5, value: 158927 },
      { year: 2026, month: 6, value: 158984 }
    ]);
  });

  it("returns {} for a malformed body (live-observed: REQUEST_FAILED + Results: null)", () => {
    expect(parseBlsTimeseriesResponse({ status: "REQUEST_FAILED", responseTime: 0, message: ["bad input"], Results: null })).toEqual(
      {}
    );
  });

  it("returns {} for null/non-object/empty input, never throws", () => {
    expect(parseBlsTimeseriesResponse(null)).toEqual({});
    expect(parseBlsTimeseriesResponse(undefined)).toEqual({});
    expect(parseBlsTimeseriesResponse("not json")).toEqual({});
    expect(parseBlsTimeseriesResponse({})).toEqual({});
    expect(parseBlsTimeseriesResponse({ status: "REQUEST_SUCCEEDED", Results: { series: "not an array" } })).toEqual({});
  });

  it("keeps an unknown/invalid series ID as an empty array rather than dropping it (live-observed shape)", () => {
    const parsed = parseBlsTimeseriesResponse({
      status: "REQUEST_SUCCEEDED",
      responseTime: 73,
      message: ["Invalid Series for Series ZZZZINVALID000"],
      Results: { series: [{ seriesID: "ZZZZINVALID000", data: [] }] }
    });
    expect(parsed["ZZZZINVALID000"]).toEqual([]);
  });
});

describe("deriveBlsMacroSeries", () => {
  it("computes CPI YoY %, unemployment rate, and payrolls MoM change from parsed rows", () => {
    const parsed = parseBlsTimeseriesResponse(liveShapedResponse());
    const result = deriveBlsMacroSeries(parsed);
    expect(result).not.toBeNull();
    // (333.952 - 322.561) / 322.561 * 100
    expect(result?.cpiInflation).toBe("3.53%");
    expect(result?.unemploymentRate).toBe("4.20%");
    // 158984 - 158927
    expect(result?.nonfarmPayrollsChangeK).toBe("+57K");
    expect(result?.asOf).toBe("2026-06");
  });

  it("formats a negative payrolls change with a leading minus, not a doubled sign", () => {
    const result = deriveBlsMacroSeries({
      CES0000000001: [
        { year: 2026, month: 5, value: 158927 },
        { year: 2026, month: 6, value: 158900 }
      ]
    });
    expect(result?.nonfarmPayrollsChangeK).toBe("-27K");
  });

  it("omits a field whose exact prior-period row is missing (never diffs across a gap)", () => {
    // Nov 2025 payrolls MoM would need Oct 2025, which is missing entirely from this fixture.
    const result = deriveBlsMacroSeries({
      CES0000000001: [
        { year: 2025, month: 9, value: 158548 },
        { year: 2025, month: 11, value: 158449 }
      ]
    });
    expect(result?.nonfarmPayrollsChangeK).toBeUndefined();
    expect(result).toBeNull();
  });

  it("returns a partial object when only some series resolved", () => {
    const result = deriveBlsMacroSeries({
      LNS14000000: [{ year: 2026, month: 6, value: 4.2 }]
    });
    expect(result).toEqual({ unemploymentRate: "4.20%", asOf: "2026-06" });
  });

  it("returns null when nothing resolved at all (empty rows for every series)", () => {
    expect(deriveBlsMacroSeries({})).toBeNull();
    expect(deriveBlsMacroSeries({ CUUR0000SA0: [], LNS14000000: [], CES0000000001: [] })).toBeNull();
  });
});

describe("resolveBlsApiKey", () => {
  const original = process.env.BLS_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.BLS_API_KEY;
    else process.env.BLS_API_KEY = original;
  });

  it("returns undefined when unset or blank", () => {
    delete process.env.BLS_API_KEY;
    expect(resolveBlsApiKey()).toBeUndefined();
    process.env.BLS_API_KEY = "   ";
    expect(resolveBlsApiKey()).toBeUndefined();
  });

  it("returns the trimmed key when set", () => {
    process.env.BLS_API_KEY = "  abc123  ";
    expect(resolveBlsApiKey()).toBe("abc123");
  });
});

describe("fetchBlsMacroSeries", () => {
  const originalKey = process.env.BLS_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    clearBlsMacroCacheForTests();
    if (originalKey === undefined) delete process.env.BLS_API_KEY;
    else process.env.BLS_API_KEY = originalKey;
  });

  it("parses a real successful response end-to-end", async () => {
    delete process.env.BLS_API_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => liveShapedResponse() })
    );
    const result = await fetchBlsMacroSeries(Date.UTC(2026, 6, 2));
    expect(result?.cpiInflation).toBe("3.53%");
    expect(result?.unemploymentRate).toBe("4.20%");
    expect(result?.nonfarmPayrollsChangeK).toBe("+57K");
  });

  it("returns null on a non-ok HTTP response, never throws", async () => {
    delete process.env.BLS_API_KEY;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchBlsMacroSeries(Date.now())).toBeNull();
  });

  it("returns null on a network error / abort, never throws", async () => {
    delete process.env.BLS_API_KEY;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await fetchBlsMacroSeries(Date.now())).toBeNull();
  });

  it("returns null on a malformed body (live-observed REQUEST_FAILED shape), not a fabricated value", async () => {
    delete process.env.BLS_API_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "REQUEST_FAILED", responseTime: 0, message: ["bad input"], Results: null })
      })
    );
    expect(await fetchBlsMacroSeries(Date.now())).toBeNull();
  });

  it("omits registrationkey from the request body when no key is configured (keyless tier)", async () => {
    delete process.env.BLS_API_KEY;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => liveShapedResponse() });
    vi.stubGlobal("fetch", fetchMock);
    await fetchBlsMacroSeries(Date.now());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.bls.gov/publicAPI/v2/timeseries/data/");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body).not.toHaveProperty("registrationkey");
    expect(body.seriesid).toEqual(["CUUR0000SA0", "LNS14000000", "CES0000000001"]);
  });

  it("includes registrationkey in the request body when BLS_API_KEY is configured (registered tier)", async () => {
    process.env.BLS_API_KEY = "my-test-key";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => liveShapedResponse() });
    vi.stubGlobal("fetch", fetchMock);
    await fetchBlsMacroSeries(Date.now());

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.registrationkey).toBe("my-test-key");
  });

  it("caches a successful result and does not re-fetch within the TTL", async () => {
    delete process.env.BLS_API_KEY;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => liveShapedResponse() });
    vi.stubGlobal("fetch", fetchMock);

    const now = Date.now();
    const first = await fetchBlsMacroSeries(now);
    const second = await fetchBlsMacroSeries(now + 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("does not cache past a failure for long — retries well before the positive TTL would allow", async () => {
    delete process.env.BLS_API_KEY;
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);

    const now = Date.now();
    await fetchBlsMacroSeries(now);
    // 1 hour later — still within the (much longer) positive TTL, but past the negative TTL.
    await fetchBlsMacroSeries(now + 60 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
