import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { upsertConnectedAccount } from "../src/lib/db";
import { EtoroRatesResponseSchema, getEToroGateway } from "../src/lib/etoro";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-etoro-schema-${randomUUID()}.db`)}`;
  upsertConnectedAccount({
    id: "acct-etoro-schema",
    userId: "local",
    broker: "etoro",
    environment: "paper",
    accountNumber: "ETORO-SCHEMA",
    label: "eToro schema",
    apiKey: "etoro-api-key",
    apiSecret: "etoro-user-key",
    isActive: true
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("eToro boundary schemas", () => {
  it("accepts a rates envelope and an eligibility envelope", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const href = String(url);
      if (href.includes("/market-data/search")) {
        return jsonResponse({ items: [{ instrumentId: 1001, internalSymbolFull: "AAPL" }] });
      }
      if (href.includes("/instruments/rates")) {
        return jsonResponse({ rates: [{ instrumentID: 1001, bid: 10, ask: 12, lastExecution: 11, date: "2026-10-15" }] });
      }
      if (href.includes("/eligibility")) {
        return jsonResponse({ items: [{ symbol: "AAPL", allowOpenPosition: true, unitsQuantityType: "fractional" }] });
      }
      throw new Error(`unexpected ${href}`);
    });

    const gateway = getEToroGateway("local", "acct-etoro-schema");
    const quotes = await gateway.getEquityQuotes("ETORO-SCHEMA", ["AAPL"]);
    expect(quotes.AAPL).toMatchObject({ symbol: "AAPL", price: 11, bid: 10, ask: 12, provider: "etoro" });
    const tradability = await gateway.getEquityTradability("ETORO-SCHEMA", ["AAPL"]);
    expect(tradability.AAPL).toEqual({ tradable: true, fractional: true, reason: undefined });
  });

  it("rejects a rates body that is not the documented envelope", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const href = String(url);
      if (href.includes("/market-data/search")) {
        return jsonResponse({ items: [{ instrumentId: 1001, internalSymbolFull: "AAPL" }] });
      }
      if (href.includes("/instruments/rates")) return jsonResponse({ rates: "nope" });
      throw new Error(`unexpected ${href}`);
    });

    const gateway = getEToroGateway("local", "acct-etoro-schema");
    await expect(gateway.getEquityQuotes("ETORO-SCHEMA", ["AAPL"])).rejects.toThrow();
    expect(() => EtoroRatesResponseSchema.parse({ rates: "nope" })).toThrow();
  });
});
