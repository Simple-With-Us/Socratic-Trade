import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/history", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/history")>();
  return { ...actual, fetchDailyOHLC: vi.fn() };
});

import { fetchDailyOHLC } from "@/lib/history";

describe("/api/history", () => {
  it("returns close-only history rows instead of dropping them as empty", async () => {
    vi.mocked(fetchDailyOHLC).mockResolvedValueOnce([
      { time: "2026-06-25", close: 57.5 },
      { time: "2026-06-26", close: 57.88 }
    ]);
    const { GET } = await import("../app/api/history/route");

    const response = await GET(new Request("http://localhost/api/history?symbol=BAC"));
    const body = await response.json();

    expect(body.symbol).toBe("BAC");
    expect(body.bars).toEqual([
      { time: "2026-06-25", close: 57.5 },
      { time: "2026-06-26", close: 57.88 }
    ]);
  });
});
