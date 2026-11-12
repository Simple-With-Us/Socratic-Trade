import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/history", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/history")>();
  return { ...actual, fetchDailyOHLC: vi.fn() };
});

import { fetchDailyOHLC } from "@/lib/history";

const closeOnlyBars = [
  { time: "2026-06-25", close: 57.5 },
  { time: "2026-06-26", close: 57.88 }
];

async function getHistory(symbol = "BAC") {
  const { GET } = await import("../app/api/history/route");
  return GET(new Request(`http://localhost/api/history?symbol=${symbol}`));
}

describe("/api/history", () => {
  afterEach(() => {
    vi.mocked(fetchDailyOHLC).mockReset();
    vi.restoreAllMocks();
  });

  it("returns close-only history rows instead of dropping them as empty", async () => {
    vi.mocked(fetchDailyOHLC).mockResolvedValueOnce(closeOnlyBars);
    const response = await getHistory();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.symbol).toBe("BAC");
    expect(body.bars).toEqual([
      { time: "2026-06-25", close: 57.5 },
      { time: "2026-06-26", close: 57.88 }
    ]);
  });

  it("returns 200 with empty bars when the provider has no history", async () => {
    vi.mocked(fetchDailyOHLC).mockResolvedValueOnce(closeOnlyBars);
    const control = await getHistory();
    expect(control.status).toBe(200);
    expect((await control.json()).bars).toHaveLength(2);

    vi.mocked(fetchDailyOHLC).mockResolvedValueOnce([]);
    const response = await getHistory();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ symbol: "BAC", bars: [], note: "no price history available" });
  });

  it("returns 502 broker_unavailable when fetchDailyOHLC resolves null", async () => {
    vi.mocked(fetchDailyOHLC).mockResolvedValueOnce(closeOnlyBars);
    const control = await getHistory();
    expect(control.status).toBe(200);
    expect((await control.json()).bars).toHaveLength(2);

    const metrics = await import("../src/lib/sentry-metrics");
    const capture = vi.spyOn(metrics, "captureHandledException").mockImplementation(() => {});
    vi.mocked(fetchDailyOHLC).mockResolvedValueOnce(null);
    try {
      const response = await getHistory();
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        ok: false,
        error: "broker_unavailable",
        message: "Price history is temporarily unavailable."
      });
      expect(capture).toHaveBeenCalledOnce();
      expect(capture.mock.calls[0]?.[1]).toBe("Price history fetch failed");
    } finally {
      capture.mockRestore();
    }
  });

  it("returns 502 broker_unavailable when the history provider rejects", async () => {
    vi.mocked(fetchDailyOHLC).mockResolvedValueOnce(closeOnlyBars);
    const control = await getHistory();
    expect(control.status).toBe(200);

    const metrics = await import("../src/lib/sentry-metrics");
    const capture = vi.spyOn(metrics, "captureHandledException").mockImplementation(() => {});
    vi.mocked(fetchDailyOHLC).mockRejectedValueOnce(new Error("Yahoo HTTP 503"));
    try {
      const response = await getHistory();
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: "broker_unavailable",
        message: "Broker returned HTTP 503."
      });
      expect(capture).toHaveBeenCalledOnce();
      expect(capture.mock.calls[0]?.[1]).toBe("Price history fetch failed");
    } finally {
      capture.mockRestore();
    }
  });

  it("returns 401 when identity resolution denies the request, not a broker outage", async () => {
    vi.mocked(fetchDailyOHLC).mockResolvedValueOnce(closeOnlyBars);
    expect((await getHistory()).status).toBe(200);

    const requestUser = await import("../src/lib/request-user");
    const denied = Response.json({ ok: false, error: "verified_identity_required" }, { status: 401 });
    const spy = vi.spyOn(requestUser, "resolveRequestUserIdOrResponse").mockReturnValue(denied);
    try {
      const response = await getHistory();
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "verified_identity_required" });
      expect(fetchDailyOHLC).toHaveBeenCalledOnce(); // only the control request
    } finally {
      spy.mockRestore();
    }
  });

  it("returns 500 internal_error when identity resolution throws a local database fault", async () => {
    vi.mocked(fetchDailyOHLC).mockResolvedValueOnce(closeOnlyBars);
    expect((await getHistory()).status).toBe(200);

    const requestUser = await import("../src/lib/request-user");
    const spy = vi.spyOn(requestUser, "resolveRequestUserIdOrResponse").mockImplementation(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    try {
      const response = await getHistory();
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ ok: false, error: "internal_error" });
      expect(fetchDailyOHLC).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it("returns 500 internal_error when the provider throws a local adapter defect", async () => {
    vi.mocked(fetchDailyOHLC).mockResolvedValueOnce(closeOnlyBars);
    expect((await getHistory()).status).toBe(200);

    vi.mocked(fetchDailyOHLC).mockRejectedValueOnce(new TypeError("Cannot read properties of null"));
    const response = await getHistory();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, error: "internal_error" });
  });
});
