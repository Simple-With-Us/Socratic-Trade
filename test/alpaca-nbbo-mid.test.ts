/**
 * Board 009b99f0: Alpaca getEquityQuotes must price the mid when both sides
 * are numbers.  Ask alone biased the displayed price, alerts, and stops.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

let latestQuotes: Record<string, { bp?: number; ap?: number; t?: string }> = {};
let latestTrades: Record<string, { p?: number; s?: number; t?: string }> = {};

vi.mock("@alpacahq/alpaca-trade-api", () => {
  class MockAlpaca {
    async getLatestQuotes() {
      return latestQuotes;
    }
    async getLatestTrades() {
      return latestTrades;
    }
    async getAccount() {
      return { account_number: "ACC-NBBO", portfolio_value: "10000", equity: "10000", cash: "10000" };
    }
  }
  return { Alpaca: MockAlpaca, default: MockAlpaca };
});

beforeEach(async () => {
  latestQuotes = {};
  latestTrades = {};
  vi.resetModules();
  vi.unstubAllEnvs();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-alpaca-nbbo-${randomUUID()}.db`)}`;
  const { upsertConnectedAccount } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: "acc-nbbo",
    userId: "local",
    broker: "alpaca",
    environment: "paper",
    accountNumber: "ACC-NBBO",
    baseUrl: "https://paper-api.alpaca.markets",
    apiKey: "PK_TEST",
    apiSecret: "secret",
    isActive: true,
    label: "Alpaca Paper NBBO"
  });
});

describe("Alpaca getEquityQuotes NBBO price", () => {
  it("uses the last print, then the two-sided mid, and never a size or a one-sided book", async () => {
    latestQuotes = {
      AAPL: { bp: 199, ap: 201, t: "2026-08-15T14:00:00.000Z" },
      MSFT: { ap: 300, t: "2026-08-15T14:00:00.000Z" },
      XOM: { bp: 110, t: "2026-08-15T14:00:00.000Z" },
      NVDA: { bp: 490, ap: 510, t: "2026-08-15T14:00:00.000Z" }
    };
    latestTrades = {
      NVDA: { p: 505, s: 100, t: "2026-08-15T14:01:00.000Z" },
      AAPL: { s: 40 }
    };
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const quotes = await getAlpacaGateway("local", "acc-nbbo").getEquityQuotes("ACC-NBBO", ["AAPL", "MSFT", "XOM", "NVDA"]);

    expect(quotes.AAPL?.price).toBe(200);
    expect(quotes.AAPL?.bid).toBe(199);
    expect(quotes.AAPL?.ask).toBe(201);
    expect(quotes.AAPL?.asOf).toBe("2026-08-15T14:00:00.000Z");
    expect(quotes.AAPL?.price).not.toBe(40);
    expect(quotes.MSFT).toBeUndefined();
    expect(quotes.XOM).toBeUndefined();
    expect(quotes.NVDA?.price).toBe(505);
    expect(quotes.NVDA?.price).not.toBe(100);
    expect(quotes.NVDA?.price).not.toBe(500);
    expect(quotes.NVDA?.asOf).toBe("2026-08-15T14:01:00.000Z");
  });
});
