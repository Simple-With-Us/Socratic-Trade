/**
 * Unit tests for Alpaca market data resolution and real-time quotes.
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveAlpacaMarketData } from "../src/lib/db-api-keys";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `alpaca-marketdata-test-${randomUUID()}.db`)}`;
});

describe("Alpaca Market Data Real-time Priority", () => {
  beforeEach(() => {
    delete process.env.ALPACA_LIVE_API_KEY;
    delete process.env.ALPACA_LIVE_SECRET_KEY;
    delete process.env.APCA_API_KEY_ID;
    delete process.env.APCA_API_SECRET_KEY;
    delete process.env.ALPACA_PAPER_API_KEY;
    delete process.env.ALPACA_PAPER_SECRET_KEY;
  });

  it("prioritizes live market data keys over paper keys in environment", () => {
    process.env.ALPACA_LIVE_API_KEY = "LIVE_KEY_123";
    process.env.ALPACA_LIVE_SECRET_KEY = "LIVE_SECRET_456";
    process.env.ALPACA_PAPER_API_KEY = "PAPER_KEY_789";
    process.env.ALPACA_PAPER_SECRET_KEY = "PAPER_SECRET_012";

    const resolved = resolveAlpacaMarketData();
    expect(resolved.apiKey).toBe("LIVE_KEY_123");
    expect(resolved.secretKey).toBe("LIVE_SECRET_456");
    expect(resolved.source).toBe("env");
  });

  it("returns none when no keys exist", () => {
    const resolved = resolveAlpacaMarketData();
    expect(resolved.source).toBe("none");
  });
});
