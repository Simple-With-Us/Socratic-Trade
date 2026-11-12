import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/history", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/history")>();
  return { ...actual, fetchDailyOHLC: vi.fn() };
});

import { fetchDailyOHLC } from "@/lib/history";

describe("/api/history", () => {
  afterEach(() => {
    vi.mocked(fetchDailyOHLC).mockReset();
  });

  it("returns close-only history rows instead of dropping them as empty", async () => {
    vi.mocked(fetchDailyOHLC).mockResolvedValueOnce([
      { time: "2026-06-25", close: 57.5 },
      { time: "2026-06-26", close: 57.88 }
    ]);
    const { GET } = await import("../app/api/history/route");

    const response = await GET(new Request("http://localhost/api/history?symbol=BAC"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.symbol).toBe("BAC");
    expect(body.bars).toEqual([
      { time: "2026-06-25", close: 57.5 },
      { time: "2026-06-26", close: 57.88 }
    ]);
  });

  it("returns 200 with empty bars when the provider has no history", async () => {
    vi.mocked(fetchDailyOHLC).mockResolvedValueOnce([]);
    const { GET } = await import("../app/api/history/route");
    const response = await GET(new Request("http://localhost/api/history?symbol=BAC"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ symbol: "BAC", bars: [], note: "no price history available" });
  });

  it("returns 502 broker_unavailable when the history provider fails", async () => {
    vi.mocked(fetchDailyOHLC).mockRejectedValueOnce(new Error("Yahoo HTTP 503"));
    const { GET } = await import("../app/api/history/route");
    const response = await GET(new Request("http://localhost/api/history?symbol=BAC"));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      error: "broker_unavailable",
      message: "Price history is temporarily unavailable."
    });
  });
});
