import { describe, expect, it } from "vitest";
import {
  DEFAULT_TICKER_LOGO_DISPLAY,
  isTickerLogoDisplay,
  normalizeTickerLogoSymbol,
  tickerLogoCandidates,
  tickerLogoRawUrl
} from "../src/lib/ticker-logos";

describe("ticker logo helpers", () => {
  it("defaults to the transparent display (falls back to a tile monogram on logo failure)", () => {
    expect(DEFAULT_TICKER_LOGO_DISPLAY).toBe("transparent");
    expect(isTickerLogoDisplay("tile")).toBe(true);
    expect(isTickerLogoDisplay("transparent")).toBe(true);
    expect(isTickerLogoDisplay("off")).toBe(true);
    expect(isTickerLogoDisplay("normal")).toBe(false);
  });

  it("normalizes ticker symbols without allowing arbitrary paths", () => {
    expect(normalizeTickerLogoSymbol(" aapl ")).toBe("AAPL");
    expect(normalizeTickerLogoSymbol("$msft")).toBe("MSFT");
    expect(normalizeTickerLogoSymbol("BRK.B")).toBe("BRK.B");
    expect(normalizeTickerLogoSymbol("../AAPL")).toBeNull();
    expect(normalizeTickerLogoSymbol("RDS/A")).toBeNull();
    expect(normalizeTickerLogoSymbol("")).toBeNull();
  });

  it("tries common class-share filename variants", () => {
    expect(tickerLogoCandidates("brk.b")).toEqual(["BRK.B", "BRK-B", "BRK_B"]);
    expect(tickerLogoCandidates("brk-b")).toEqual(["BRK-B", "BRK.B", "BRK_B"]);
  });

  it("builds raw GitHub URLs for the sanitized candidate", () => {
    expect(tickerLogoRawUrl("AAPL")).toBe("https://raw.githubusercontent.com/davidepalazzo/ticker-logos/main/ticker_icons/AAPL.png");
  });
});
