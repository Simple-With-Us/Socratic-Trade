/**
 * Board 009b99f0: Alpaca getEquityQuotes must price the mid when both sides
 * are numbers.  Ask alone biased the displayed price, alerts, and stops.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

let latestQuotes: Record<string, { bp?: number; ap?: number; t?: string }> = {};

vi.mock("@alpacahq/alpaca-trade-api", () => {
  return {
    default: class MockAlpaca {
      async getLatestQuotes() {
        return latestQuotes;
      }
      async getAccount() {
        return { account_number: "ACC-NBBO", portfolio_value: "10000", equity: "10000", cash: "10000" };
      }
    }
  };
});

beforeEach(async () => {
  latestQuotes = {};
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
  it("uses the mid when both bid and ask are numbers, else the single side", async () => {
    latestQuotes = {
      AAPL: { bp: 199, ap: 201, t: "2026-08-15T14:00:00.000Z" },
      MSFT: { ap: 300, t: "2026-08-15T14:00:00.000Z" },
      XOM: { bp: 110, t: "2026-08-15T14:00:00.000Z" }
    };
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const quotes = await getAlpacaGateway("local", "acc-nbbo").getEquityQuotes("ACC-NBBO", ["AAPL", "MSFT", "XOM"]);

    expect(quotes.AAPL?.price).toBe(200);
    expect(quotes.AAPL?.bid).toBe(199);
    expect(quotes.AAPL?.ask).toBe(201);
    expect(quotes.AAPL?.price).not.toBe(quotes.AAPL?.ask);
    expect(quotes.MSFT?.price).toBe(300);
    expect(quotes.XOM?.price).toBe(110);
  });
});
