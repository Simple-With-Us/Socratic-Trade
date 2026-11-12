import { describe, expect, it } from "vitest";
import {
  DATA_POINT_CATALOG,
  dataPointsForSource,
  describeSourcesFor,
  getDataPoint,
  isStAllowedSource,
  listDataPoints,
  sourcesFor
} from "../src/lib/source-capability-matrix";

describe("source-capability-matrix", () => {
  it("lists data points and every catalog entry has at least one source", () => {
    const ids = listDataPoints();
    expect(ids.length).toBeGreaterThan(20);
    for (const spec of DATA_POINT_CATALOG) {
      expect(spec.sources.length).toBeGreaterThan(0);
      expect(getDataPoint(spec.id)?.id).toBe(spec.id);
    }
  });

  it("returns strategic order for peRatio and excludes retired FMP by default", () => {
    const rows = sourcesFor("peRatio");
    expect(rows[0]?.sourceId).toBe("yahoo-finance");
    expect(rows.every((r) => r.sourceId !== "fmp")).toBe(true);
    const withForbidden = sourcesFor("peRatio", { includeForbidden: true });
    expect(withForbidden.some((r) => r.sourceId === "fmp" && !r.stAllowed)).toBe(true);
  });

  it("documents full transcript source map including ROIC + EarningsCalls + retired FMP", () => {
    const rows = sourcesFor("earnings_transcript", { includeForbidden: true });
    const ids = rows.map((r) => r.sourceId);
    expect(ids).toContain("roic-earnings-transcript");
    expect(ids).toContain("earningscalls");
    expect(ids).toContain("fmp-earnings-transcript");
    expect(sourcesFor("earnings_transcript").every((r) => r.stAllowed)).toBe(true);
    expect(sourcesFor("earnings_transcript").some((r) => r.sourceId === "fmp-earnings-transcript")).toBe(false);
  });

  it("marks FMP and Quiver as not ST-allowed", () => {
    expect(isStAllowedSource("fmp")).toBe(false);
    expect(isStAllowedSource("quiverquant")).toBe(false);
    expect(isStAllowedSource("yahoo-finance")).toBe(true);
  });

  it("prefers cboe-options for near-the-money IV", () => {
    const rows = sourcesFor("nearTheMoneyIv");
    expect(rows[0]?.sourceId).toBe("cboe-options");
    expect(rows.some((r) => r.sourceId === "alpaca-options")).toBe(true);
    expect(rows.some((r) => r.sourceId === "tradier-options")).toBe(true);
  });

  it("maps yahoo-finance to many scan fields", () => {
    const pts = dataPointsForSource("yahoo-finance");
    expect(pts).toContain("price");
    expect(pts).toContain("peRatio");
    expect(pts).toContain("shortPercentOfFloat");
  });

  it("describeSourcesFor is non-empty for known points", () => {
    const text = describeSourcesFor("earnings_transcript");
    expect(text).toMatch(/roic-earnings-transcript/);
    expect(text).toMatch(/earningscalls/);
  });
});
