import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchIntradayBars } from "@/lib/market-realtime";
import { GET as intradayRoute } from "../app/api/market/intraday/[symbol]/route";

vi.mock("@/lib/market-realtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/market-realtime")>();
  return { ...actual, fetchIntradayBars: vi.fn() };
});

const mockFetchIntradayBars = vi.mocked(fetchIntradayBars);

const TEST_TOKEN = "st_ingest_intraday_test";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-intraday-route-${randomUUID()}.db`)}`;
  process.env.APP_B_INGEST_TOKEN = TEST_TOKEN;
});

beforeEach(() => {
  process.env.APP_B_INGEST_TOKEN = TEST_TOKEN;
  mockFetchIntradayBars.mockReset();
});

function authedRequest(url: string): Request {
  return new Request(url, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
}

describe("GET /api/market/intraday/[symbol] failure contract", () => {
  it("returns 502 when no provider confirmed the window", async () => {
    mockFetchIntradayBars.mockResolvedValueOnce({ kind: "unavailable", reason: "alpaca bars HTTP 403" });
    const res = await intradayRoute(
      authedRequest("http://x/api/market/intraday/AAPL?start=2026-08-20T14:40:00.000Z&end=2026-08-20T15:40:00.000Z"),
      { params: Promise.resolve({ symbol: "AAPL" }) }
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "alpaca bars HTTP 403" });
    expect(mockFetchIntradayBars).toHaveBeenCalledWith(
      "AAPL",
      "2026-08-20T14:40:00.000Z",
      "2026-08-20T15:40:00.000Z",
      "1Min",
      undefined,
      { operatorPeerRead: true }
    );
  });

  it("returns 200 with empty bars when a provider confirmed no prints", async () => {
    mockFetchIntradayBars.mockResolvedValueOnce({ kind: "ok", bars: [] });
    const res = await intradayRoute(
      authedRequest("http://x/api/market/intraday/AAPL?start=2026-08-20T14:40:00.000Z&end=2026-08-20T15:40:00.000Z"),
      { params: Promise.resolve({ symbol: "AAPL" }) }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, symbol: "AAPL", bars: [] });
  });
});
