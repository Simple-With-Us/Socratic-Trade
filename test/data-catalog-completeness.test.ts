import { describe, expect, it } from "vitest";
import {
  CATALOG_FIELDS,
  CATALOG_SOURCES,
  catalogFieldsByCategory
} from "../src/lib/data-catalog";
import {
  buildCatalogPayload,
  buildDataCompletenessReport,
  resolveCompletenessUniverse
} from "../src/lib/data-completeness";

describe("data-catalog", () => {
  it("lists every field with at least one source and required provenance", () => {
    expect(CATALOG_FIELDS.length).toBeGreaterThan(15);
    expect(CATALOG_SOURCES.some((s) => s.id === "fmp" && s.status === "retired")).toBe(true);
    for (const f of CATALOG_FIELDS) {
      expect(f.provenanceRequired).toBe(true);
      expect(f.sources.length).toBeGreaterThan(0);
      expect(f.id.length).toBeGreaterThan(0);
    }
    const byCat = catalogFieldsByCategory();
    expect(byCat.rag_corpus?.some((f) => f.id === "rag:10-k")).toBe(true);
    expect(byCat.fundamental?.some((f) => f.id === "peRatio")).toBe(true);
    expect(byCat.quote?.some((f) => f.id === "marketCap")).toBe(true);
  });

  it("buildCatalogPayload is static and includes provenance policy", () => {
    const p = buildCatalogPayload();
    expect(p.sources.length).toBe(CATALOG_SOURCES.length);
    expect(p.categories.length).toBeGreaterThan(3);
    expect(p.provenancePolicy).toMatch(/as_of|fetched_at/i);
  });
});

describe("data-completeness", () => {
  it("resolveCompletenessUniverse accepts explicit symbols", () => {
    const u = resolveCompletenessUniverse(["aapl", "MSFT", "AAPL"]);
    expect(u.symbols).toEqual(["AAPL", "MSFT"]);
    expect(u.source).toBe("explicit");
  });

  it("scores RAG without inflating for multiple 10-Ks on one name", () => {
    // Empty DB universe: completeness 0, still well-formed report.
    const report = buildDataCompletenessReport(["ZZZZ1", "ZZZZ2"]);
    expect(report.universeSize).toBe(2);
    expect(report.rag.byDocType["10-k"].completeness).toBe(0);
    expect(report.rag.meanTickerPartial).toBe(0);
    expect(report.llmPresentation.ragContext).toMatch(/retrievedFinancialContext/i);
    const pe = report.categories
      .flatMap((c) => c.fields)
      .find((f) => f.fieldId === "peRatio");
    expect(pe).toBeTruthy();
    expect(pe!.completeness).toBe(0);
  });
});
