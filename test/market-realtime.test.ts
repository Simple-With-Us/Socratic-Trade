import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { barAt, fetchIntradayBars, normalizeTimeframe, toRobinhoodInterval, type IntradayBar } from "@/lib/market-realtime";
import { resolveAlpacaHistoryCredential } from "@/lib/history";
import { getStoredMcpOAuthTokens } from "@/lib/mcp-oauth";
import { fetchRobinhoodHistoricals, robinhoodMcpDataEnabled } from "@/lib/robinhood";

vi.mock("@/lib/history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/history")>();
  return { ...actual, resolveAlpacaHistoryCredential: vi.fn() };
});

vi.mock("@/lib/mcp-oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp-oauth")>();
  return { ...actual, getStoredMcpOAuthTokens: vi.fn(() => undefined) };
});

vi.mock("@/lib/robinhood", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/robinhood")>();
  return {
    ...actual,
    robinhoodMcpDataEnabled: vi.fn(() => false),
    fetchRobinhoodHistoricals: vi.fn()
  };
});

const mockResolveAlpaca = vi.mocked(resolveAlpacaHistoryCredential);
const mockRhEnabled = vi.mocked(robinhoodMcpDataEnabled);
const mockRhHistoricals = vi.mocked(fetchRobinhoodHistoricals);
const mockStoredTokens = vi.mocked(getStoredMcpOAuthTokens);

const bars: IntradayBar[] = [
  { t: "2026-08-06T15:05:00Z", c: 100 },
  { t: "2026-08-06T15:06:00Z", c: 101 },
  { t: "2026-08-06T15:10:00Z", c: 102 },
  { t: "2026-08-06T15:40:00Z", c: 110 }
];

describe("barAt", () => {
  it("returns the bar at the exact instant", () => {
    expect(barAt(bars, "2026-08-06T15:06:00Z")?.c).toBe(101);
  });

  it("takes the NEXT bar when the instant falls in a gap", () => {
    // Thin names skip minutes; 15:07-15:09 have no print, so 15:10 is the honest answer.
    expect(barAt(bars, "2026-08-06T15:07:00Z")?.c).toBe(102);
  });

  it("refuses to reach past the tolerance instead of answering with a distant bar", () => {
    // 15:11 -> next bar is 15:40, 29 minutes away. Within a 5-minute tolerance that is not an
    // answer to "the price at 15:11", it is a different part of the session.
    expect(barAt(bars, "2026-08-06T15:11:00Z")).toBeNull();
    expect(barAt(bars, "2026-08-06T15:11:00Z", 40)?.c).toBe(110);
  });

  it("never returns an EARLIER bar — a past price is not a price at time T", () => {
    expect(barAt(bars, "2026-08-06T16:00:00Z")).toBeNull();
  });

  it("returns null on an unparseable instant rather than throwing", () => {
    expect(barAt(bars, "not-a-timestamp")).toBeNull();
  });

  it("returns null on an empty series", () => {
    expect(barAt([], "2026-08-06T15:06:00Z")).toBeNull();
  });
});

describe("normalizeTimeframe", () => {
  it("passes through supported timeframes", () => {
    expect(normalizeTimeframe("5Min")).toBe("5Min");
    expect(normalizeTimeframe("1Hour")).toBe("1Hour");
  });

  it("falls back to the FINEST resolution on a typo, never a coarser one", () => {
    // A silent downgrade to hour bars would answer a minute-resolution question wrongly.
    expect(normalizeTimeframe("1min")).toBe("1Min");
    expect(normalizeTimeframe("garbage")).toBe("1Min");
    expect(normalizeTimeframe(null)).toBe("1Min");
    expect(normalizeTimeframe(undefined)).toBe("1Min");
  });
});

describe("toRobinhoodInterval", () => {
  it("maps the 1-minute bar to Robinhood's 'minute', not '1minute'", () => {
    // Robinhood silently accepts an unknown interval and auto-selects one, so the wrong
    // spelling returns hour bars for a minute-resolution question.
    expect(toRobinhoodInterval("1Min")).toBe("minute");
  });

  it("maps 15Min to the nearest COARSER bar Robinhood actually has", () => {
    // Robinhood has no 15-minute bar. Rounding DOWN to 5minute would silently change the
    // question; 30minute is coarser and honest about it.
    expect(toRobinhoodInterval("15Min")).toBe("30minute");
  });

  it("defaults unknown timeframes to minute resolution", () => {
    expect(toRobinhoodInterval("nonsense")).toBe("minute");
  });
});

describe("fetchIntradayBars provider failure vs confirmed empty", () => {
  const start = "2026-08-20T14:40:00.000Z";
  const end = "2026-08-20T15:40:00.000Z";

  beforeEach(() => {
    mockRhEnabled.mockReturnValue(false);
    mockRhHistoricals.mockReset();
    mockStoredTokens.mockReturnValue(undefined);
    mockResolveAlpaca.mockReturnValue({ apiKey: "PK-TEST", secretKey: "SK-TEST", source: "env" });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks Alpaca HTTP 403 as unavailable, not an empty window", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("forbidden", { status: 403 }))
    );
    const result = await fetchIntradayBars("AAPL", start, end);
    expect(result).toEqual({ kind: "unavailable", reason: "alpaca bars HTTP 403" });
  });

  it("marks a network timeout as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("aborted");
      })
    );
    const result = await fetchIntradayBars("AAPL", start, end);
    expect(result).toEqual({ kind: "unavailable", reason: "alpaca bars request failed" });
  });

  it("returns ok [] when Alpaca confirms the window has no bars", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ bars: [], next_page_token: null }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    const result = await fetchIntradayBars("AAPL", start, end);
    expect(result).toEqual({ kind: "ok", bars: [] });
  });

  it("returns ok bars when Alpaca answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            bars: [{ t: "2026-08-20T14:43:00Z", o: 1, h: 2, l: 1, c: 1.5, v: 10 }],
            next_page_token: null
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    const result = await fetchIntradayBars("AAPL", start, end);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.bars).toEqual([{ t: "2026-08-20T14:43:00Z", o: 1, h: 2, l: 1, c: 1.5, v: 10 }]);
    }
  });

  it("is unavailable when no history credential is configured", async () => {
    mockResolveAlpaca.mockReturnValue({ source: "env" });
    const result = await fetchIntradayBars("AAPL", start, end);
    expect(result).toEqual({ kind: "unavailable", reason: "no history credential" });
  });

  it("does not use Robinhood from ROBINHOOD_MCP_AUTH_TOKEN alone, even on the peer path", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTH_TOKEN", "env-operator-token");
    mockRhEnabled.mockReturnValue(true);
    mockStoredTokens.mockReturnValue(undefined);
    mockResolveAlpaca.mockReturnValue({ source: "env" });
    const result = await fetchIntradayBars("AAPL", start, end, "1Min", undefined, { operatorPeerRead: true });
    expect(mockRhHistoricals).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "unavailable", reason: "no history credential" });
  });

  it("does not use operator Robinhood unless operatorPeerRead is set", async () => {
    mockRhEnabled.mockReturnValue(true);
    mockStoredTokens.mockReturnValue({ accessToken: "local-stored", tokenType: "Bearer" });
    vi.stubEnv("ROBINHOOD_MCP_AUTH_TOKEN", "env-operator-token");
    mockResolveAlpaca.mockReturnValue({ source: "env" });
    const result = await fetchIntradayBars("AAPL", start, end);
    expect(mockRhHistoricals).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "unavailable", reason: "no history credential" });
  });

  it("uses the operator stored token on the CT peer path, not the env var", async () => {
    mockRhEnabled.mockReturnValue(true);
    mockStoredTokens.mockReturnValue({ accessToken: "local-stored", tokenType: "Bearer" });
    mockRhHistoricals.mockResolvedValue([{ time: "2026-08-20T14:43:00Z", close: 1.5, open: 1, high: 2, low: 1, volume: 10 }]);
    const result = await fetchIntradayBars("AAPL", start, end, "1Min", undefined, { operatorPeerRead: true });
    expect(mockRhHistoricals).toHaveBeenCalledWith("AAPL", expect.objectContaining({ userId: "local", startTime: start, endTime: end }));
    expect(result).toEqual({
      kind: "ok",
      bars: [{ t: "2026-08-20T14:43:00Z", o: 1, h: 2, l: 1, c: 1.5, v: 10 }]
    });
  });
});
