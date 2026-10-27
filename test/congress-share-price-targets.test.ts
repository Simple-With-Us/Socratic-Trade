import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { marketQuoteToAnalyst } from "../src/lib/congress-share";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-price-targets-${randomUUID()}.db`)}`;
});

// The fundamentals/analyst push (marketQuoteToFundamentals/marketQuoteToAnalyst) already exists; this
// suite covers the 2026-06-25 addition: numeric price targets threaded onto the quote now flow into the
// analyst[] import row, and stay omitted when absent (App A's nullable columns).

describe("marketQuoteToAnalyst — numeric price targets", () => {
  it("emits targetMean/High/Low/Median when the quote carries them", () => {
    const row = marketQuoteToAnalyst(
      {
        symbol: "nvda",
        analystRating: "Strong Buy",
        analystBySource: { fmp: { score: 90, label: "Strong Buy", counts: { strongBuy: 20, buy: 5, hold: 2, sell: 0, strongSell: 0 } } },
        targetMean: 130,
        targetHigh: 160,
        targetLow: 100,
        targetMedian: 128
      },
      "2026-06-25"
    );
    expect(row).toMatchObject({
      ticker: "NVDA", rating: "Strong Buy", strongBuy: 20, buy: 5, hold: 2,
      targetMean: 130, targetHigh: 160, targetLow: 100, targetMedian: 128
    });
  });

  it("omits target keys entirely when the quote has none", () => {
    const row = marketQuoteToAnalyst({ symbol: "AAPL", analystRating: "Buy" }, "2026-06-25")!;
    expect(row).toEqual({ ticker: "AAPL", date: "2026-06-25", rating: "Buy" });
    expect(row).not.toHaveProperty("targetMean");
  });

  it("can produce a row carrying ONLY targets (no rating/counts)", () => {
    const row = marketQuoteToAnalyst({ symbol: "MSFT", targetMean: 500 }, "2026-06-25");
    expect(row).toEqual({ ticker: "MSFT", date: "2026-06-25", targetMean: 500 });
  });

  it("drops non-finite target values", () => {
    const row = marketQuoteToAnalyst({ symbol: "F", analystRating: "Hold", targetMean: Number.NaN, targetHigh: 14 }, "2026-06-25")!;
    expect(row).not.toHaveProperty("targetMean");
    expect(row.targetHigh).toBe(14);
  });
});
