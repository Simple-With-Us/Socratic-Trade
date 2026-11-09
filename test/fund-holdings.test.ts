import { describe, expect, it } from "vitest";
import { parseBlackRockSpreadsheetSymbols } from "../src/lib/fund-holdings";

describe("BlackRock fund holdings parser", () => {
  it("extracts USD equity tickers and normalizes known share-class symbols", () => {
    const xml = workbook([
      ["Ticker", "Name", "Asset Class", "Currency"],
      ["AAPL", "APPLE INC", "Equity", "USD"],
      ["BRKB", "BERKSHIRE HATHAWAY INC CLASS B", "Equity", "USD"],
      ["USD", "US DOLLAR", "Cash and/or Derivatives", "USD"],
      ["SHOP", "SHOPIFY INC", "Equity", "CAD"]
    ]);

    expect(parseBlackRockSpreadsheetSymbols(xml)).toEqual(["AAPL", "BRK-B"]);
  });
});

function workbook(rows: string[][]): string {
  return [
    '<?xml version="1.0"?>',
    '<ss:Workbook xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
    "<ss:Worksheet><ss:Table>",
    ...rows.map((row) => `<ss:Row>${row.map((cell) => `<ss:Cell><ss:Data ss:Type="String">${cell}</ss:Data></ss:Cell>`).join("")}</ss:Row>`),
    "</ss:Table></ss:Worksheet></ss:Workbook>"
  ].join("");
}
