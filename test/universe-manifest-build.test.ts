// ST-4690 (A4e): the pure assembly step the universe-manifest generator calls. These tests pin the
// two invariants a fresh live run must satisfy without needing network access: (1) no emitted
// issuer is a sentinel (every row has a verified exchange and real measurements, dataQuality
// "live"), and (2) quarantine drops are backfilled from the ordered SEC list until the target
// count is reached — or the build refuses rather than writing a degraded artifact.
import { describe, expect, it } from "vitest";
import {
  buildSecUniverseManifest,
  normalizeManifestTicker,
  type SecMarketDatum,
  type SecTickerRow
} from "../src/lib/rag/universe-manifest-build";
import {
  hashSecUniverseIssuers,
  validateSecUniverseManifest,
  type SecUniverseSourceReceipt
} from "../src/lib/rag/universe-manifest";

const SOURCES: SecUniverseSourceReceipt[] = [
  { name: "sec-company-tickers", asOf: "2026-11-26T00:00:00.000Z", sha256: "a".repeat(64) },
  { name: "sec-company-tickers-exchange", asOf: "2026-11-26T00:00:00.000Z", sha256: "b".repeat(64) },
  { name: "nasdaq-delayed-screener", asOf: "2026-11-26T00:00:00.000Z", sha256: "c".repeat(64) }
];

function secRow(cikNumber: number, ticker: string): SecTickerRow {
  return { cik: String(cikNumber).padStart(10, "0"), ticker, title: `${ticker} Incorporated` };
}

function quote(overrides: Partial<SecMarketDatum> = {}): SecMarketDatum {
  return { price: 10, volume: 1_000, marketCap: 100_000, sector: "Technology", industry: "Software", ...overrides };
}

function build(input: {
  rows: SecTickerRow[];
  exchanges?: Array<[number, string]>;
  quotes?: Array<[string, SecMarketDatum]>;
  target: number;
  dbSymbols?: string[];
  indexSymbols?: string[];
}) {
  return buildSecUniverseManifest({
    secRows: input.rows,
    cikToExchange: new Map((input.exchanges ?? []).map(([cik, exchange]) => [String(cik).padStart(10, "0"), exchange])),
    marketByTicker: new Map(input.quotes ?? []),
    dbSymbols: input.dbSymbols,
    indexSymbols: input.indexSymbols,
    sources: SOURCES,
    generatedAt: "2026-11-26T15:00:00.000Z",
    snapshotId: "sec-rag-2026-11-26",
    targetIssuerCount: input.target,
    selectionMethod: "unit-test selection"
  });
}

describe("buildSecUniverseManifest (ST-4690 / A4e)", () => {
  it("emits exactly the target count of live rows, backfilling quarantine drops in SEC order", () => {
    const rows = [
      secRow(1, "AAA"),
      secRow(2, "BBB"), // no quote -> quarantined
      secRow(3, "CCC"),
      secRow(4, "DDD"), // no exchange -> quarantined (never emitted as "UNKNOWN")
      secRow(5, "EEE")
    ];
    const { manifest, stats } = build({
      rows,
      exchanges: [[1, "NASDAQ"], [2, "NYSE"], [3, "NYSE"], [5, "NASDAQ"]],
      quotes: [["AAA", quote()], ["CCC", quote({ price: 20, volume: 500, marketCap: 500_000 })], ["EEE", quote()]],
      target: 3
    });

    expect(manifest.issuers.map((issuer) => issuer.ticker)).toEqual(["AAA", "CCC", "EEE"]);
    expect(manifest.issuers.map((issuer) => issuer.rank)).toEqual([1, 2, 3]);
    expect(stats.emitted).toBe(3);
    expect(stats.marketCapLiquidity).toBe(3);
    expect(stats.withSector).toBe(3);
    expect(validateSecUniverseManifest(manifest, { expectedIssuerCount: 3 })).toEqual([]);
    expect(manifest.issuerSha256).toBe(hashSecUniverseIssuers(manifest.issuers));

    // No sentinel shapes: a real exchange, a live marker, and measured figures.
    for (const issuer of manifest.issuers) {
      expect(issuer.exchange).not.toBe("UNKNOWN");
      expect(issuer.dataQuality).toBe("live");
      expect(issuer.marketCapUsd).toBeGreaterThan(0);
      expect(issuer.dollarVolumeUsd).toBeGreaterThan(0);
      expect(issuer.sourceRefs).toEqual(SOURCES.map((source) => source.name));
    }
    expect(manifest.issuers[1]).toMatchObject({ ticker: "CCC", marketCapUsd: 500_000, dollarVolumeUsd: 10_000 });

    // The drops are recorded with honest reasons instead of disappearing.
    expect(manifest.quarantined).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ticker: "BBB", reason: expect.stringContaining("no usable market quote") }),
        expect.objectContaining({ ticker: "DDD", reason: expect.stringContaining("no verified listing exchange") })
      ])
    );
    expect(stats.quarantineReasons["no usable market quote (price/volume/market-cap) at generation time"]).toBe(1);
    expect(stats.quarantineReasons["no verified listing exchange in SEC company_tickers_exchange.json"]).toBe(1);
  });

  it("carries tranche provenance: DB history first, then index membership, then SEC fill", () => {
    const rows = [secRow(10, "XYZ"), secRow(11, "AAA"), secRow(12, "FILL")];
    const { manifest } = build({
      rows,
      exchanges: [[10, "NASDAQ"], [11, "NYSE"], [12, "NYSE"]],
      quotes: [["XYZ", quote()], ["AAA", quote()], ["FILL", quote()]],
      dbSymbols: ["XYZ"],
      indexSymbols: ["AAA", "XYZ"],
      target: 3
    });
    expect(manifest.issuers.map((issuer) => [issuer.ticker, issuer.inclusionReason])).toEqual([
      ["XYZ", "research-priority"],
      ["AAA", "index-member"],
      ["FILL", "market-cap-liquidity"]
    ]);
  });

  it("merges a second SEC ticker of the same CIK as an alias and never crosses CIKs", () => {
    const alphabetCik = 1_652_044;
    const rows = [secRow(alphabetCik, "GOOG"), secRow(alphabetCik, "GOOGL"), secRow(320_193, "AAPL")];
    const { manifest, stats } = build({
      rows,
      exchanges: [[alphabetCik, "NASDAQ"], [320_193, "NASDAQ"]],
      quotes: [["GOOG", quote()], ["GOOGL", quote()], ["AAPL", quote()]],
      target: 2
    });
    expect(manifest.issuers.map((issuer) => [issuer.ticker, issuer.aliases])).toEqual([
      ["GOOG", ["GOOGL"]],
      ["AAPL", []]
    ]);
    expect(stats.emitted).toBe(2);
    expect(validateSecUniverseManifest(manifest, { expectedIssuerCount: 2 })).toEqual([]);
  });

  it("quarantines a DB-history symbol that SEC's ticker list does not contain", () => {
    const { manifest, stats } = build({
      rows: [secRow(20, "REAL")],
      exchanges: [[20, "NYSE"]],
      quotes: [["REAL", quote()]],
      dbSymbols: ["GONE"],
      target: 1
    });
    expect(manifest.issuers.map((issuer) => issuer.ticker)).toEqual(["REAL"]);
    expect(manifest.quarantined).toEqual([
      expect.objectContaining({ ticker: "GONE", reason: expect.stringContaining("not in SEC company_tickers.json") })
    ]);
    expect(stats.quarantined).toBe(1);
  });

  it("refuses to build when fewer issuers have a verified exchange and a real quote than the target", () => {
    expect(() =>
      build({
        rows: [secRow(30, "ONLY"), secRow(31, "NOQUOTE")],
        exchanges: [[30, "NYSE"], [31, "NYSE"]],
        quotes: [["ONLY", quote()]],
        target: 2
      })
    ).toThrow(/Refusing to write a degraded universe/);
  });

  it("refuses to build when a quote has zero volume (dollar volume would not be a measurement)", () => {
    expect(() =>
      build({
        rows: [secRow(40, "ZERO")],
        exchanges: [[40, "NYSE"]],
        quotes: [["ZERO", quote({ volume: 0 })]],
        target: 1
      })
    ).toThrow(/Refusing to write a degraded universe/);
  });

  it("normalizes Nasdaq's dotted/slashed share-class symbols to the manifest's hyphen form", () => {
    expect(normalizeManifestTicker("BRK.B")).toBe("BRK-B");
    expect(normalizeManifestTicker("AKO/A")).toBe("AKO-A");
    expect(normalizeManifestTicker(" aapl ")).toBe("AAPL");
  });
});