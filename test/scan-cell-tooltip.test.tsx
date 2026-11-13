import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScanCellValue } from "../app/console/scan/scan-table";
import { SCAN_COLUMNS } from "../app/console/scan/columns";
import type { MarketQuote } from "../src/lib/types";

const quote = { symbol: "EXE", price: 123.45, score: 88, sources: { price: "yahoo-finance" } } as MarketQuote;

describe("desktop scan value explanations", () => {
  it("keeps the exact value and source in a focusable described trigger", () => {
    const column = SCAN_COLUMNS.find((item) => item.id === "price")!;
    const html = renderToStaticMarkup(<ScanCellValue column={column} quote={quote} received="Received fixture-time" className="justify-end" />);
    expect(html).toContain("123.45");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("aria-describedby=");
    expect(html).toContain("Last price");
    expect(html).toContain("Yahoo");
    expect(html).toContain("Received fixture-time");
    expect(html).toContain("justify-end");
    expect(html).not.toContain("<button");
    expect(html).not.toContain(" title=");
  });

  it("does not duplicate an existing Received stamp", () => {
    const column = { id: "fixture", label: "Fixture", headerTitle: "Fixture", sortValue: () => 1, render: () => "value", cellTitle: () => "Source details\nReceived field-time" };
    const html = renderToStaticMarkup(<ScanCellValue column={column} quote={quote} received="Received scan-time" />);
    expect(html).toContain("Received field-time");
    expect(html).not.toContain("scan-time");
  });

  it("keeps missing values honest while exposing the explanation", () => {
    const column = SCAN_COLUMNS.find((item) => item.id === "score")!;
    const html = renderToStaticMarkup(<ScanCellValue column={column} quote={{ ...quote, score: undefined } as unknown as MarketQuote} received="" />);
    expect(html).toContain("No scan score was recorded");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });
});
