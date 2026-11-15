import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { cellTitleWithReceived, ScanValueDetails } from "../app/console/scan/value-details";
import { SCAN_COLUMNS } from "../app/console/scan/columns";
import type { MarketQuote } from "../src/lib/types";

const quote = { symbol: "EXE", price: 123.45, sources: { price: "yahoo-finance" } } as MarketQuote;
const price = SCAN_COLUMNS.find((column) => column.id === "price")!;
describe("scan value details", () => {
  it("adds exactly one closed control for the entire scan, not per value", () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ ...quote, symbol: `EX${i}` }));
    const html = renderToStaticMarkup(<ScanValueDetails rows={rows} columns={SCAN_COLUMNS} received="Received fixture" />);
    expect((html.match(/<button/g) ?? [])).toHaveLength(1);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('role="tooltip"');
    expect(html).not.toContain("<select");
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain("EX1999");
  });
  it.each([{ columns: [] }, { columns: [SCAN_COLUMNS[0]] }])("disables a scan without read-only value columns", ({ columns }) => {
    expect(renderToStaticMarkup(<ScanValueDetails rows={[quote]} columns={columns} received="" />)).toContain('disabled=""');
  });
  it("disables an empty scan", () => {
    expect(renderToStaticMarkup(<ScanValueDetails rows={[]} columns={[price]} received="" />)).toContain('disabled=""');
  });
  it("keeps exact source and scan-level receipt", () => {
    const description = cellTitleWithReceived(price, quote, "Received scan-time");
    expect(description).toContain("Last price");
    expect(description).toContain("Yahoo");
    expect(description).toContain("Received scan-time");
  });
  it("preserves field receipt without adding a second scan receipt", () => {
    const column = { ...price, cellTitle: () => "Source details\nReceived field-time" };
    expect(cellTitleWithReceived(column, quote, "Received scan-time")).toBe("Source details\nReceived field-time");
  });
  it("does not invent missing provenance or timestamps", () => {
    const column = { ...price, cellTitle: () => undefined };
    expect(cellTitleWithReceived(column, quote, "")).toBeUndefined();
  });
  it("keeps missing values honest", () => {
    const score = SCAN_COLUMNS.find((column) => column.id === "score")!;
    expect(cellTitleWithReceived(score, quote, "")).toContain("No scan score was recorded");
  });
});
