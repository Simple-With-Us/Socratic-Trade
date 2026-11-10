import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-alt-test-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.FRED_API_KEY;
  delete process.env.FINNHUB_API_KEY;
});

describe("Yahoo Finance Quotes", () => {
  it("fetches and parses Yahoo Finance chart data correctly", async () => {
    const { fetchYahooFinanceQuote } = await import("../src/lib/robinhood");

    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("query1.finance.yahoo.com")) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    longName: "Apple Inc.",
                    regularMarketPrice: 205.5,
                    chartPreviousClose: 203.2
                  },
                  indicators: {
                    quote: [
                      {
                        volume: [1500000]
                      }
                    ]
                  }
                }
              ]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });

    const quote = await fetchYahooFinanceQuote("AAPL");
    expect(quote).toBeDefined();
    expect(quote?.companyName).toBe("Apple Inc.");
    expect(quote?.price).toBe(205.5);
    expect(quote?.prevClose).toBe(203.2);
    expect(quote?.volume).toBe(1500000);
    expect(quote?.bid).toBeCloseTo(205.5 * 0.999);
    expect(quote?.ask).toBeCloseTo(205.5 * 1.001);
  });

  it("returns undefined on network failure", async () => {
    const { fetchYahooFinanceQuote } = await import("../src/lib/robinhood");

    vi.stubGlobal("fetch", async () => {
      return new Response("error", { status: 500 });
    });

    const quote = await fetchYahooFinanceQuote("INVALID");
    expect(quote).toBeUndefined();
  });
});

describe("FRED Macroeconomic Data", () => {
  it("returns BLANK FRED fields (no placeholder constants) when FRED_API_KEY is not set", async () => {
    const { fetchMacroData } = await import("../src/lib/macro");
    delete process.env.FRED_API_KEY;
    // Block the key-free Yahoo ^VIX fallback too so the result is deterministic: fully
    // unavailable -- every field "" (never a fabricated constant), asOf "unavailable".
    vi.stubGlobal("fetch", async () => {
      throw new Error("no network in test");
    });

    const data = await fetchMacroData();
    expect(data.fedFundsRate).toBe("");
    expect(data.dgs10Treasury).toBe("");
    expect(data.cpiInflation).toBe("");
    expect(data.unemploymentRate).toBe("");
    expect(data.vix).toBe("");
    expect(data.asOf).toBe("unavailable");
    expect(data.fredSourced).toBe(false);
  });

  it("fetches from FRED API when API key is set", async () => {
    process.env.FRED_API_KEY = "test-key";
    const { fetchMacroData } = await import("../src/lib/macro");

    vi.stubGlobal("fetch", async (url: string) => {
      let value = "0.0";
      if (url.includes("FEDFUNDS")) value = "5.33";
      else if (url.includes("DGS10")) value = "4.45";
      else if (url.includes("CPIAUCSL")) value = "3.25";
      else if (url.includes("UNRATE")) value = "4.0";

      return new Response(
        JSON.stringify({
          observations: [{ value }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const data = await fetchMacroData();
    expect(data.fedFundsRate).toBe("5.33%");
    expect(data.dgs10Treasury).toBe("4.45%");
    expect(data.cpiInflation).toBe("3.25%");
    expect(data.unemploymentRate).toBe("4.00%");
  });
});

describe("Finnhub News Enrichment", () => {
  it("uses Yahoo Finance provider when no API key is configured", async () => {
    delete process.env.FINNHUB_API_KEY;
    delete process.env.FMP_API_KEY;
    delete process.env.ALPHAVANTAGE_API_KEY;
    const { getEnrichmentProvider } = await import("../src/lib/data-providers");

    const provider = getEnrichmentProvider();
    // Yahoo Finance is the final real tier — always configured, no API key required.
    expect(provider.configured).toBe(true);
    expect(provider.name).toContain("yahoo-finance");
  });

  it("fetches and scores company news from Finnhub when key is configured", async () => {
    process.env.FINNHUB_API_KEY = "finnhub-key";
    process.env.ALPHAVANTAGE_API_KEY = "alpha-vantage-key";
    delete process.env.FMP_API_KEY;
    const { getEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("NEWS_SENTIMENT")) {
        return new Response(
          JSON.stringify({
            feed: [
              {
                title: "AAPL surges as new AI chip outperforms competitors",
                ticker_sentiment: [{ ticker: "AAPL", ticker_sentiment_score: "0.25" }] // 0.25 -> 75 sentiment
              },
              {
                title: "Apple wins major patent lawsuit against rival",
                ticker_sentiment: [{ ticker: "AAPL", ticker_sentiment_score: "0.35" }] // 0.35 -> 85 sentiment
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("company-news")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("stock/recommendation")) {
        return new Response(
          JSON.stringify([{ strongBuy: 20, buy: 10, hold: 2, sell: 0, strongSell: 0 }]),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      // Other endpoints return empty but valid responses.
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    });

    const provider = getEnrichmentProvider();
    expect(provider.configured).toBe(true);
    expect(provider.name).toContain("finnhub");
    expect(provider.name).toContain("alpha-vantage");

    const result = await provider.enrich(["AAPL"]);
    expect(result.AAPL).toBeDefined();
    // Sentiment is from Alpha Vantage now
    expect(result.AAPL.sentiment).toBe(80); // (0.25 + 0.35) / 2 = 0.30 -> mapped to 80
    expect(result.AAPL.sources?.sentiment).toBe("alpha-vantage");
    expect(result.AAPL.headlines).toHaveLength(2);
    expect(result.AAPL.headlines?.[0]).toContain("AAPL surges");
    // Analyst recommendation → blended 0–100 score + per-source breakdown.
    expect(result.AAPL.analystBySource?.finnhub?.score).toBeGreaterThan(80); // mostly strong buy/buy
    expect(typeof result.AAPL.analystScore).toBe("number");
    expect(result.AAPL.analystRating).toBeTruthy();
  });
});

describe("Discord Rich Notification Webhook", () => {
  it("formats Discord payload with embeds and color codes", async () => {
    // Legacy webhook path re-validates its target with a real DNS lookup on every send
    // (SSRF/rebinding hardening — src/lib/egress-guard.ts); stub it for a hermetic test.
    const resolveWebhookHost = async () => ["8.8.8.8"];

    const { sendNotification } = await import("../src/lib/notifications");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");

    let capturedBody: any = null;
    const mockFetcher = async (url: any, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(null, { status: 204 }) as any;
    };

    const policy = {
      ...DEFAULT_POLICY,
      notificationSettings: {
        enabledEvents: ["fill", "block", "pending_approval", "kill_switch", "run_failed"] as any[],
        webhookUrl: "https://discord.com/api/webhooks/12345/abcde"
      }
    };

    // Test Pending Approval (Orange color: 15105570)
    await sendNotification(
      {
        type: "pending_approval",
        title: "AAPL awaiting approval",
        payload: {
          proposalId: "p-1",
          proposal: {
            symbol: "AAPL",
            side: "buy",
            type: "market",
            dollarAmount: 50,
            rationale: "Strong earnings report"
          },
          review: { estimatedNotional: 49.95 }
        }
      },
      { policy, fetcher: mockFetcher, resolveWebhookHost }
    );

    expect(capturedBody).toBeDefined();
    expect(capturedBody.embeds).toHaveLength(1);
    const embed = capturedBody.embeds[0];
    expect(embed.title).toBe("AAPL awaiting approval");
    expect(embed.color).toBe(15105570); // Orange
    expect(embed.description).toBe("**Rationale:** Strong earnings report");
    expect(embed.fields).toContainEqual({ name: "Symbol", value: "AAPL", inline: true });
    expect(embed.fields).toContainEqual({ name: "Side", value: "BUY", inline: true });
    expect(embed.fields).toContainEqual({ name: "Dollar Amount", value: "$50.00", inline: true });

    // Test Fill Notification (Green color: 3066993)
    await sendNotification(
      {
        type: "fill",
        title: "AAPL Paper fill",
        payload: {
          runId: "run-123",
          fill: {
            symbol: "AAPL",
            side: "buy",
            status: "filled",
            quantity: 2,
            price: 200,
            notional: 400
          }
        }
      },
      { policy, fetcher: mockFetcher, resolveWebhookHost }
    );

    expect(capturedBody.embeds[0].color).toBe(3066993);
    expect(capturedBody.embeds[0].fields).toContainEqual({ name: "Symbol", value: "AAPL", inline: true });
    expect(capturedBody.embeds[0].fields).toContainEqual({ name: "Price", value: "$200.00", inline: true });
    expect(capturedBody.embeds[0].fields).toContainEqual({ name: "Notional", value: "$400.00", inline: true });
  });
});
