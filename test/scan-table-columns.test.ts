import { describe, expect, it } from "vitest";
import { DEFAULT_VISIBLE_SCAN_COLUMN_IDS, SCAN_COLUMNS } from "../app/console/scan/columns";
import { moveVisibleScanColumn, sanitizeVisibleScanColumns, toggleVisibleScanColumn } from "../app/console/scan/scan-table";

describe("scan-table column state", () => {
  it("falls back to the default visible columns when saved state is invalid", () => {
    expect(sanitizeVisibleScanColumns(null)).toEqual(DEFAULT_VISIBLE_SCAN_COLUMN_IDS);
    expect(sanitizeVisibleScanColumns({ bad: true })).toEqual(DEFAULT_VISIBLE_SCAN_COLUMN_IDS);
    expect(sanitizeVisibleScanColumns([])).toEqual(DEFAULT_VISIBLE_SCAN_COLUMN_IDS);
  });

  it("keeps only valid unique ids and restores symbol if a saved payload dropped it", () => {
    expect(sanitizeVisibleScanColumns(["price", "bogus", "price", "score"])).toEqual(["symbol", "price", "score"]);
    expect(sanitizeVisibleScanColumns(["price", "symbol", "score"])).toEqual(["symbol", "price", "score"]);
  });

  it("toggles non-symbol columns without allowing symbol to disappear", () => {
    expect(toggleVisibleScanColumn(["symbol", "score", "price"], "price")).toEqual(["symbol", "score"]);
    expect(toggleVisibleScanColumn(["symbol", "score"], "price")).toEqual(["symbol", "score", "price"]);
    expect(toggleVisibleScanColumn(["symbol", "score"], "symbol")).toEqual(["symbol", "score"]);
  });

  it("moves visible columns earlier or later while clamping at the edges", () => {
    expect(moveVisibleScanColumn(["symbol", "score", "price"], "price", -1)).toEqual(["symbol", "price", "score"]);
    expect(moveVisibleScanColumn(["symbol", "score", "price"], "score", -1)).toEqual(["symbol", "score", "price"]);
    expect(moveVisibleScanColumn(["symbol", "score", "price"], "symbol", -1)).toEqual(["symbol", "score", "price"]);
    expect(moveVisibleScanColumn(["symbol", "score", "price"], "price", 1)).toEqual(["symbol", "score", "price"]);
  });

  it("assigns expected text alignments to scan columns", () => {
    const symbolCol = SCAN_COLUMNS.find((c) => c.id === "symbol");
    const priceCol = SCAN_COLUMNS.find((c) => c.id === "price");
    const scoreCol = SCAN_COLUMNS.find((c) => c.id === "score");
    const newsCol = SCAN_COLUMNS.find((c) => c.id === "sentiment");
    const insiderCol = SCAN_COLUMNS.find((c) => c.id === "insiderSentiment");

    expect(symbolCol?.align).toBe("left");
    expect(priceCol?.align).toBe("right");
    expect(scoreCol?.align).toBe("center");
    expect(newsCol?.align).toBe("center");
    expect(newsCol?.label).toBe("News");
    expect(insiderCol?.align).toBe("center");
    expect(insiderCol?.label).toBe("Insiders");
  });

  it("sorts News and Insiders columns separately", () => {
    const newsCol = SCAN_COLUMNS.find((c) => c.id === "sentiment");
    const insiderCol = SCAN_COLUMNS.find((c) => c.id === "insiderSentiment");

    const quote = { symbol: "AAPL", sentiment: 75, insiderSentiment: 60 } as any;
    const quoteInsiderOnly = { symbol: "MSFT", insiderSentiment: 68 } as any;

    expect(newsCol?.sortValue(quote)).toBe(75);
    expect(newsCol?.sortValue(quoteInsiderOnly)).toBeUndefined();

    expect(insiderCol?.sortValue(quote)).toBe(60);
    expect(insiderCol?.sortValue(quoteInsiderOnly)).toBe(68);
  });
});
