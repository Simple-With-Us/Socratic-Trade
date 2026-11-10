import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchAlpacaAccountActivities,
  fetchAlpacaMarketCalendar,
  fetchAlpacaMarketClock,
  fetchAlpacaPortfolioHistory,
} from "../src/lib/alpaca-account-insights";
import { getServiceHealthLog, isSoftHealthFailure } from "../src/lib/db-health";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-alpaca-insights-${randomUUID()}.db`)}`;
});

const originalKey = process.env.ALPACA_PAPER_API_KEY;
const originalSecret = process.env.ALPACA_PAPER_SECRET_KEY;
const originalBase = process.env.ALPACA_TRADING_BASE_URL;

async function seedConnectedAlpaca(
  userId: string,
  environment: "paper" | "live" = "paper",
  apiKey = "key-id",
  apiSecret = "key-secret"
) {
  const { upsertConnectedAccount } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: `${userId}-alpaca-${environment}-${randomUUID()}`,
    userId,
    broker: "alpaca",
    environment,
    accountNumber: `${environment.toUpperCase()}-1`,
    label: `${environment} Alpaca`,
    apiKey,
    apiSecret,
    isActive: true
  });
}

describe("alpaca-account-insights", () => {
  beforeEach(() => {
    process.env.ALPACA_PAPER_API_KEY = "key-id";
    process.env.ALPACA_PAPER_SECRET_KEY = "key-secret";
    delete process.env.ALPACA_TRADING_BASE_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.ALPACA_PAPER_API_KEY;
    else process.env.ALPACA_PAPER_API_KEY = originalKey;
    if (originalSecret === undefined) delete process.env.ALPACA_PAPER_SECRET_KEY;
    else process.env.ALPACA_PAPER_SECRET_KEY = originalSecret;
    if (originalBase === undefined) delete process.env.ALPACA_TRADING_BASE_URL;
    else process.env.ALPACA_TRADING_BASE_URL = originalBase;
  });

  describe("fetchAlpacaPortfolioHistory", () => {
    it("hits the trading portfolio-history endpoint with auth headers and maps the equity curve", async () => {
      await seedConnectedAlpaca("u1");
      let capturedUrl = "";
      let capturedHeaders: Record<string, string> = {};
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = init.headers as Record<string, string>;
        return new Response(
          JSON.stringify({
            timestamp: [1_700_000_000, 1_700_086_400],
            equity: [100_000, 101_250],
            profit_loss: [0, 1_250],
            profit_loss_pct: [0, 0.0125],
            base_value: 100_000,
            timeframe: "1D",
          })
        );
      });

      const result = await fetchAlpacaPortfolioHistory("u1", { period: "1M", timeframe: "1D" });

      expect(capturedUrl).toContain("paper-api.alpaca.markets");
      expect(capturedUrl).toContain("/v2/account/portfolio/history");
      expect(capturedUrl).toContain("period=1M");
      expect(capturedUrl).toContain("timeframe=1D");
      expect(capturedHeaders["APCA-API-KEY-ID"]).toBe("key-id");
      expect(capturedHeaders["APCA-API-SECRET-KEY"]).toBe("key-secret");
      expect(result?.equity).toEqual([100_000, 101_250]);
      expect(result?.profit_loss_pct).toEqual([0, 0.0125]);
      expect(result?.timeframe).toBe("1D");
    });

    it("returns undefined when no Alpaca credential is available", async () => {
      delete process.env.ALPACA_PAPER_API_KEY;
      delete process.env.ALPACA_PAPER_SECRET_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const result = await fetchAlpacaPortfolioHistory("u-no-alpaca");
      expect(result).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns undefined on an HTTP error", async () => {
      await seedConnectedAlpaca("u-http");
      vi.stubGlobal("fetch", async () => new Response("nope", { status: 403 }));
      const result = await fetchAlpacaPortfolioHistory("u-http");
      expect(result).toBeUndefined();
    });

    it("selects the live trading host for a live connected account", async () => {
      await seedConnectedAlpaca("u-live", "live");
      let capturedUrl = "";
      vi.stubGlobal("fetch", async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ timestamp: [], equity: [], profit_loss: [], profit_loss_pct: [], timeframe: "1D" }));
      });

      await fetchAlpacaPortfolioHistory("u-live");
      expect(capturedUrl).toBe("https://api.alpaca.markets/v2/account/portfolio/history");
    });
  });

  describe("fetchAlpacaMarketCalendar", () => {
    it("hits the calendar endpoint with start/end and maps session info", async () => {
      let capturedUrl = "";
      vi.stubGlobal("fetch", async (url: string) => {
        capturedUrl = url;
        return new Response(
          JSON.stringify([
            {
              date: "2026-06-30",
              open: "09:30",
              close: "16:00",
              session_open: "0400",
              session_close: "2000",
            },
          ])
        );
      });

      const days = await fetchAlpacaMarketCalendar({ start: "2026-06-01", end: "2026-06-30" });

      expect(capturedUrl).toContain("/v2/calendar");
      expect(capturedUrl).toContain("start=2026-06-01");
      expect(capturedUrl).toContain("end=2026-06-30");
      expect(days).toHaveLength(1);
      expect(days[0].date).toBe("2026-06-30");
      expect(days[0].open).toBe("09:30");
      expect(days[0].close).toBe("16:00");
    });

    it("returns an empty array when no Alpaca credential is available", async () => {
      delete process.env.ALPACA_PAPER_API_KEY;
      delete process.env.ALPACA_PAPER_SECRET_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const days = await fetchAlpacaMarketCalendar();
      expect(days).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns an empty array on a network failure", async () => {
      vi.stubGlobal("fetch", async () => {
        throw new Error("network down");
      });
      const days = await fetchAlpacaMarketCalendar();
      expect(days).toEqual([]);
    });
  });

  describe("fetchAlpacaMarketClock", () => {
    it("hits the clock endpoint and maps the open state + next open/close", async () => {
      let capturedUrl = "";
      vi.stubGlobal("fetch", async (url: string) => {
        capturedUrl = url;
        return new Response(
          JSON.stringify({
            timestamp: "2026-06-30T14:00:00-04:00",
            is_open: true,
            next_open: "2026-07-01T09:30:00-04:00",
            next_close: "2026-06-30T16:00:00-04:00",
          })
        );
      });

      const clock = await fetchAlpacaMarketClock();

      expect(capturedUrl).toContain("/v2/clock");
      expect(clock?.is_open).toBe(true);
      expect(clock?.next_open).toBe("2026-07-01T09:30:00-04:00");
      expect(clock?.next_close).toBe("2026-06-30T16:00:00-04:00");
    });

    it("returns undefined when no Alpaca credential is available", async () => {
      delete process.env.ALPACA_PAPER_API_KEY;
      delete process.env.ALPACA_PAPER_SECRET_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const clock = await fetchAlpacaMarketClock();
      expect(clock).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("fetchAlpacaAccountActivities", () => {
    it("hits the activities endpoint with an activity_types filter and maps fill + non-trade rows", async () => {
      await seedConnectedAlpaca("u-activities");
      let capturedUrl = "";
      vi.stubGlobal("fetch", async (url: string) => {
        capturedUrl = url;
        return new Response(
          JSON.stringify([
            {
              id: "abc",
              activity_type: "FILL",
              transaction_time: "2026-06-30T14:00:00Z",
              type: "fill",
              price: "195.50",
              qty: "10",
              side: "buy",
              symbol: "AAPL",
              leaves_qty: "0",
              cum_qty: "10",
              order_id: "ord-1",
              order_status: "filled",
            },
            {
              id: "div",
              activity_type: "DIV",
              date: "2026-06-30",
              net_amount: "12.34",
              symbol: "MSFT",
              per_share_amount: "0.75",
              status: "executed",
            },
          ])
        );
      });

      const activities = await fetchAlpacaAccountActivities("u1", { activityTypes: ["FILL", "DIV"] });

      expect(capturedUrl).toContain("/v2/account/activities");
      expect(capturedUrl).toContain("activity_types=FILL%2CDIV");
      expect(capturedUrl).toContain("page_size=100");
      expect(activities).toHaveLength(2);
      expect(activities[0].symbol).toBe("AAPL");
      expect(activities[0].side).toBe("buy");
      expect(activities[1].activity_type).toBe("DIV");
      expect(activities[1].net_amount).toBe("12.34");
    });

    it("omits the activity_types param when none are supplied", async () => {
      await seedConnectedAlpaca("u-no-types");
      let capturedUrl = "";
      vi.stubGlobal("fetch", async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify([]));
      });

      await fetchAlpacaAccountActivities("u-no-types");
      expect(capturedUrl).toContain("/v2/account/activities");
      expect(capturedUrl).not.toContain("activity_types");
    });

    it("pages account activities by passing the last activity id as page_token", async () => {
      await seedConnectedAlpaca("u-paged");
      const urls: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        urls.push(url);
        if (url.includes("page_token=act-2")) {
          return new Response(JSON.stringify([{ id: "act-3", activity_type: "DIV" }]));
        }
        return new Response(JSON.stringify([{ id: "act-1", activity_type: "FILL" }, { id: "act-2", activity_type: "FILL" }]));
      });

      const activities = await fetchAlpacaAccountActivities("u-paged", { pageSize: 2, maxPages: 3 });

      expect(activities.map((a) => a.id)).toEqual(["act-1", "act-2", "act-3"]);
      expect(urls).toHaveLength(2);
      expect(urls[0]).toContain("page_size=2");
      expect(urls[1]).toContain("page_token=act-2");
    });

    it("returns an empty array when no Alpaca credential is available", async () => {
      delete process.env.ALPACA_PAPER_API_KEY;
      delete process.env.ALPACA_PAPER_SECRET_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const activities = await fetchAlpacaAccountActivities("u-no-activities-account");
      expect(activities).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it("honors ALPACA_TRADING_BASE_URL for the live host", async () => {
    process.env.ALPACA_TRADING_BASE_URL = "https://api.alpaca.markets/";
    let capturedUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ timestamp: "t", is_open: false, next_open: "n", next_close: "c" }));
    });

    await fetchAlpacaMarketClock();
    expect(capturedUrl).toBe("https://api.alpaca.markets/v2/clock");
  });

  // SOCRATIC-TRADE-28 ("alpaca-account-insights connection failed", 9 events/12 days — genuinely
  // low-volume, not a money-path emergency). A bare `err.message` on a Node fetch transport
  // failure is frequently just "fetch failed", which loses the real cause and does not match any
  // soft-failure text pattern db-health.ts recognizes, so a one-off network blip was logged
  // exactly like a persistent outage. These assert the call-site fix: classify + one bounded
  // retry, without touching the shared db-health.ts pipeline itself.
  describe("getJson classification + bounded retry (SOCRATIC-TRADE-28)", () => {
    const SERVICE = "alpaca-account-insights";

    function transientNetworkError(): Error {
      // Mirrors Node's real shape: fetch's own message is a content-free "fetch failed", with
      // the actual reason nested in `err.cause` — see network-errors.ts / appendErrorCause.
      return Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNRESET") });
    }

    it("retries once on a transient transport error and logs nothing for the discarded first attempt", async () => {
      const before = getServiceHealthLog(SERVICE, 1000).length;
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(transientNetworkError())
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ timestamp: "t", is_open: true, next_open: "n", next_close: "c" }))
        );
      vi.stubGlobal("fetch", fetchMock);

      const clock = await fetchAlpacaMarketClock();

      expect(clock?.is_open).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const after = getServiceHealthLog(SERVICE, 1000);
      // Exactly one new row: the eventual success. The retried-away first attempt never wrote a
      // failure row, so the blip cannot contribute to a "last 5 consecutive failures" streak.
      expect(after.length).toBe(before + 1);
      expect(after[0]?.ok).toBe(1);
    });

    it("logs a hard (non-soft) failure with the network cause appended when the transient error survives the retry", async () => {
      const before = getServiceHealthLog(SERVICE, 1000).length;
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(transientNetworkError()));

      const clock = await fetchAlpacaMarketClock();

      expect(clock).toBeUndefined();
      const after = getServiceHealthLog(SERVICE, 1000);
      // One row for the two attempts (attempt 0 is retried silently; only the final failure logs).
      expect(after.length).toBe(before + 1);
      const row = after[0]!;
      expect(row.ok).toBe(0);
      expect(row.error_text).toContain("fetch failed");
      expect(row.error_text).toContain("ECONNRESET");
      expect(isSoftHealthFailure(row.error_text)).toBe(false);
    });

    it("classifies its own request-timeout abort as soft, not a hard connection failure", async () => {
      const before = getServiceHealthLog(SERVICE, 1000).length;
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init: RequestInit) => {
          // Hangs until GET's own AbortController fires (REQUEST_TIMEOUT_MS), simulating a
          // slow-but-alive upstream rather than a transport error — advanced via fake timers below.
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          });
        })
      );

      // Fake ONLY the timer functions getJson's internal timeout actually uses — NOT Date.
      // vi.useFakeTimers()'s default also mocks Date, and advancing it 8s here would stamp this
      // test's health-log row 8s into the future, which then sorts ahead of later tests' real-time
      // rows under `ORDER BY ts DESC` and reads back as this test's leftover row in THEIR `after[0]`.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const clockPromise = fetchAlpacaMarketClock();
        await vi.advanceTimersByTimeAsync(8_000); // REQUEST_TIMEOUT_MS
        const clock = await clockPromise;
        expect(clock).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }

      const after = getServiceHealthLog(SERVICE, 1000);
      expect(after.length).toBe(before + 1);
      const row = after[0]!;
      expect(row.ok).toBe(0);
      expect(isSoftHealthFailure(row.error_text)).toBe(true);
    });

    it("scrubs the account's secret key out of a logged transport error", async () => {
      await seedConnectedAlpaca("u-secret-scrub", "paper", "leak-key-id", "super-secret-value");
      const before = getServiceHealthLog(SERVICE, 1000).length;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(
          Object.assign(new TypeError("fetch failed"), {
            cause: new Error("upstream said: super-secret-value is not authorized"),
          })
        )
      );

      const activities = await fetchAlpacaAccountActivities("u-secret-scrub");

      expect(activities).toEqual([]);
      const after = getServiceHealthLog(SERVICE, 1000);
      expect(after.length).toBe(before + 1);
      expect(after[0]?.error_text).not.toContain("super-secret-value");
      expect(after[0]?.error_text).toContain("***");
    });

    it("scrubs the account's API key out of a logged transport error too (not just the secret key)", async () => {
      // apiKey is sent as auth material either way — APCA-API-KEY-ID alongside the secret key,
      // or as the Bearer token when there is no secret key — so a cause echoing it back must be
      // scrubbed exactly like the secret key above.
      await seedConnectedAlpaca("u-apikey-scrub", "paper", "leak-api-key-value", "key-secret");
      const before = getServiceHealthLog(SERVICE, 1000).length;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(
          Object.assign(new TypeError("fetch failed"), {
            cause: new Error("upstream said: leak-api-key-value is not authorized"),
          })
        )
      );

      const activities = await fetchAlpacaAccountActivities("u-apikey-scrub");

      expect(activities).toEqual([]);
      const after = getServiceHealthLog(SERVICE, 1000);
      expect(after.length).toBe(before + 1);
      expect(after[0]?.error_text).not.toContain("leak-api-key-value");
      expect(after[0]?.error_text).toContain("***");
    });
  });
});
