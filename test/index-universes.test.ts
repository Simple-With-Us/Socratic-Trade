import { describe, expect, it } from "vitest";
import { INDICES } from "../app/console/guardrails/field-defs";
import type { IndexUniverse } from "../src/lib/types";
import {
  SUPPORTED_INDEX_UNIVERSES,
  dynamicIndexUniversesForPolicy,
  formatIndexUniverseLabels,
  formatIndexUniverseList,
  indexUniverseDisplayLabel,
  indexUniverseLabel,
  normalizeIncludedIndices,
  policyUniverseSymbolCount,
  toggleIncludedIndex
} from "../src/lib/index-universes";

describe("index universes", () => {
  it("keeps S&P 100 and S&P 500 mutually exclusive", () => {
    expect(toggleIncludedIndex(["sp500"], "sp100", true)).toEqual(["sp100"]);
    expect(toggleIncludedIndex(["sp100"], "sp500", true)).toEqual(["sp500"]);
  });

  it("keeps Nasdaq 100 and Nasdaq Composite mutually exclusive", () => {
    expect(toggleIncludedIndex(["nasdaq100"], "nasdaqComposite", true)).toEqual(["nasdaqComposite"]);
    expect(toggleIncludedIndex(["nasdaqComposite"], "nasdaq100", true)).toEqual(["nasdaq100"]);
  });

  it("normalizes conflicting API-provided selections with the later selection winning", () => {
    expect(normalizeIncludedIndices(["sp500", "sp100", "dow30"])).toEqual(["sp100", "dow30"]);
    expect(normalizeIncludedIndices(["nasdaqComposite", "nasdaq100"])).toEqual(["nasdaq100"]);
  });

  it("reports approximate counts when selected universes are dynamic", () => {
    const summary = policyUniverseSymbolCount({
      includedIndices: ["russell2000"],
      additionalSymbols: ["SPCX"],
      blocklist: ["AAPL"]
    });

    expect(summary).toEqual({ count: 2000, approximate: true });
  });

  it("identifies selected dynamic universes", () => {
    expect(dynamicIndexUniversesForPolicy({ includedIndices: ["sp500", "nyseComposite", "dow30"] })).toEqual(["nyseComposite"]);
  });
});

describe("index universe display labels", () => {
  const expected: Record<IndexUniverse, string> = {
    sp100: "S&P 100",
    sp500: "S&P 500",
    nasdaq100: "Nasdaq 100",
    nasdaqComposite: "Nasdaq Composite",
    dow30: "Dow 30",
    russell2000: "Russell 2000",
    nyseComposite: "NYSE Composite",
    ftWilshire5000: "FT Wilshire 5000"
  };

  it("maps every stored slug to the product label and never returns the slug", () => {
    expect(SUPPORTED_INDEX_UNIVERSES).toEqual(Object.keys(expected));
    for (const id of SUPPORTED_INDEX_UNIVERSES) {
      expect(indexUniverseLabel(id)).toBe(expected[id]);
      expect(indexUniverseDisplayLabel(id)).toBe(expected[id]);
      expect(indexUniverseLabel(id)).not.toBe(id);
    }
  });

  it("keeps the Guardrails INDICES chips on the same labels", () => {
    expect(INDICES.map((row) => [row.id, row.label])).toEqual(
      SUPPORTED_INDEX_UNIVERSES.map((id) => [id, expected[id]])
    );
  });

  it("formats a stored includedIndices list without leaking slugs", () => {
    expect(formatIndexUniverseLabels(["sp500", "russell2000"])).toEqual(["S&P 500", "Russell 2000"]);
    expect(formatIndexUniverseLabels(["sp500", "not-an-index", "dow30"])).toEqual(["S&P 500", "Dow 30"]);
    expect(indexUniverseDisplayLabel("sp500")).not.toMatch(/sp500/i);
    expect(formatIndexUniverseLabels(["sp500"]).join(", ")).not.toMatch(/sp500|nasdaq100|dow30/i);
  });

  it("maps the live Guardrails Indices selected-set without leaking any slug", () => {
    const leaked = ["sp500", "nasdaqComposite", "dow30", "nyseComposite"] as const;
    expect(formatIndexUniverseList(leaked)).toBe("S&P 500, Nasdaq Composite, Dow 30, NYSE Composite");
    expect(formatIndexUniverseList(leaked)).not.toMatch(/sp500|nasdaqComposite|dow30|nyseComposite|nasdaq100|russell2000|ftWilshire5000|sp100/);
    expect(formatIndexUniverseList([])).toBe("none");
    for (const id of SUPPORTED_INDEX_UNIVERSES) {
      expect(formatIndexUniverseList([id])).toBe(expected[id]);
      expect(formatIndexUniverseList([id])).not.toBe(id);
    }
  });
});
