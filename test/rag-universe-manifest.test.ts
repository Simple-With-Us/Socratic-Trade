import { describe, expect, it } from "vitest";
import {
  blockingUniverseValidationIssues,
  hashSecUniverseIssuers,
  validateSecUniverseManifest,
  type FrozenSecUniverseManifest,
  type SecUniverseIssuer
} from "../src/lib/rag/universe-manifest";

function issuer(rank: number, cik: string, ticker: string, aliases: string[] = []): SecUniverseIssuer {
  return {
    rank,
    cik,
    ticker,
    aliases,
    aliasesVerifiedAt: "2026-07-13T00:00:00.000Z",
    title: `${ticker} Corp`,
    exchange: "NASDAQ",
    securityType: "operating-company",
    sector: "Technology",
    industry: "Software",
    marketCapUsd: 1_000_000_000,
    dollarVolumeUsd: 10_000_000,
    dataQuality: "live",
    inclusionReason: "market-cap-liquidity",
    sourceRefs: ["sec-tickers", "nasdaq-screener"]
  };
}

function manifest(issuers: SecUniverseIssuer[]): FrozenSecUniverseManifest {
  return {
    schemaVersion: 2,
    snapshotId: "sec-rag-2026-07-13",
    effectiveAt: "2026-07-13T00:00:00.000Z",
    generatedAt: "2026-07-13T00:05:00.000Z",
    issuerSha256: hashSecUniverseIssuers(issuers),
    selectionMethod: "priority, then index, then market-cap and dollar-volume rank",
    sources: [
      { name: "sec-tickers", asOf: "2026-07-13T00:00:00.000Z", sha256: "a".repeat(64) },
      { name: "nasdaq-screener", asOf: "2026-07-13T00:00:00.000Z", sha256: "b".repeat(64) }
    ],
    issuers,
    quarantined: []
  };
}

describe("SEC/RAG frozen universe acceptance", () => {
  it("accepts a complete, checksummed issuer snapshot", () => {
    const value = manifest([
      issuer(1, "0000000001", "AAA", ["AAA.A"]),
      issuer(2, "0000000002", "BBB")
    ]);

    expect(validateSecUniverseManifest(value, { expectedIssuerCount: 2 })).toEqual([]);
  });

  it("rejects the legacy bare-array manifest instead of treating length as completeness", () => {
    const issues = validateSecUniverseManifest([{ cik: "0000000001", ticker: "AAA" }], { expectedIssuerCount: 1 });
    expect(issues).toEqual([
      expect.objectContaining({ code: "manifest_shape", path: "$" })
    ]);
  });

  it("rejects cross-CIK aliases and a stale checksum", () => {
    const issuers = [
      issuer(1, "0000000001", "AAA", ["SHARED"]),
      issuer(2, "0000000002", "BBB", ["SHARED"])
    ];
    const value = manifest(issuers);
    value.issuerSha256 = "c".repeat(64);

    const codes = validateSecUniverseManifest(value, { expectedIssuerCount: 2 }).map((issue) => issue.code);
    expect(codes).toContain("ticker_cross_cik");
    expect(codes).toContain("issuer_sha256_mismatch");
  });

  it("requires operating-company classification and exact coverage dimensions", () => {
    const value = manifest([issuer(1, "0000000001", "AAA")]) as unknown as Record<string, unknown>;
    const entries = value.issuers as Array<Record<string, unknown>>;
    delete entries[0]!.exchange;
    delete entries[0]!.aliases;
    entries[0]!.securityType = "fund";
    value.issuerSha256 = hashSecUniverseIssuers(entries);

    const codes = validateSecUniverseManifest(value, { expectedIssuerCount: 1 }).map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(["exchange", "security_type", "aliases"]));
  });

  it("rejects impossible calendar dates that Date.parse would otherwise normalize", () => {
    const value = manifest([issuer(1, "0000000001", "AAA")]);
    value.effectiveAt = "2026-02-31T00:00:00.000Z";
    value.sources[0]!.asOf = "2026-04-31T00:00:00.000Z";
    value.issuers[0]!.aliasesVerifiedAt = "2026-06-31T00:00:00.000Z";

    const paths = validateSecUniverseManifest(value, { expectedIssuerCount: 1 }).map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining([
      "$.effectiveAt",
      "$.sources[0].asOf",
      "$.issuers[0].aliasesVerifiedAt"
    ]));
  });

  it("accepts valid timezone offsets even when their UTC instant crosses a calendar boundary", () => {
    const value = manifest([issuer(1, "0000000001", "AAA")]);
    value.effectiveAt = "2026-07-13T00:00:00+02:00";
    value.generatedAt = "2026-07-13T23:30:00-05:00";
    value.sources[0]!.asOf = "2026-07-13T00:00:00+14:00";
    value.issuers[0]!.aliasesVerifiedAt = "2026-07-13T00:00:00-12:00";
    value.issuerSha256 = hashSecUniverseIssuers(value.issuers);

    expect(validateSecUniverseManifest(value, { expectedIssuerCount: 1 })).toEqual([]);
  });

  it("requires every quarantine entry to retain an auditable reason and valid optional identity", () => {
    const value = manifest([issuer(1, "0000000001", "AAA")]) as unknown as Record<string, unknown>;
    value.quarantined = [null, {}, { reason: "" }, { reason: "debt security", ticker: "", cik: "" }];

    const codes = validateSecUniverseManifest(value, { expectedIssuerCount: 1 }).map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining([
      "quarantine_entry_shape",
      "quarantine_reason",
      "quarantine_ticker",
      "quarantine_cik"
    ]));
  });

  it("requires normalized quarantine identifiers so exclusions remain joinable", () => {
    const value = manifest([issuer(1, "0000000001", "AAA")]);
    value.quarantined = [
      { reason: "ambiguous", ticker: "abc" },
      { reason: "ambiguous", cik: "123" }
    ];

    const codes = validateSecUniverseManifest(value, { expectedIssuerCount: 1 }).map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(["quarantine_ticker", "quarantine_cik"]));
  });

  // dataQuality (added 2026-07-19): machine-checkable marker distinguishing converter sentinel
  // placeholders (exchange:"UNKNOWN", marketCapUsd:1, dollarVolumeUsd:1) from genuine measurements.
  describe("dataQuality", () => {
    it("accepts an explicit \"sentinel\" or \"live\" value with zero issues", () => {
      const sentinelIssuer: SecUniverseIssuer = { ...issuer(1, "0000000001", "AAA"), dataQuality: "sentinel" };
      const value = manifest([sentinelIssuer]);
      value.issuerSha256 = hashSecUniverseIssuers(value.issuers);

      expect(validateSecUniverseManifest(value, { expectedIssuerCount: 1 })).toEqual([]);
    });

    it("back-compat: a manifest frozen before this field existed gets a non-blocking warning, not a validation failure", () => {
      const legacyIssuer = { ...issuer(1, "0000000001", "AAA") } as Record<string, unknown>;
      delete legacyIssuer.dataQuality;
      const value = manifest([legacyIssuer as unknown as SecUniverseIssuer]);
      value.issuerSha256 = hashSecUniverseIssuers(value.issuers);

      const issues = validateSecUniverseManifest(value, { expectedIssuerCount: 1 });
      expect(issues).toEqual([
        expect.objectContaining({ code: "data_quality_missing", path: "$.issuers[0].dataQuality", severity: "warning" })
      ]);
      // The whole point of severity:"warning" — callers gating on blocking issues must treat this
      // manifest as valid.
      expect(blockingUniverseValidationIssues(issues)).toEqual([]);
    });

    it("rejects an invalid dataQuality value as a blocking error", () => {
      const badIssuer = { ...issuer(1, "0000000001", "AAA"), dataQuality: "mock" } as unknown as SecUniverseIssuer;
      const value = manifest([badIssuer]);
      value.issuerSha256 = hashSecUniverseIssuers(value.issuers);

      const issues = validateSecUniverseManifest(value, { expectedIssuerCount: 1 });
      expect(issues).toEqual([
        expect.objectContaining({ code: "data_quality", path: "$.issuers[0].dataQuality" })
      ]);
      expect(blockingUniverseValidationIssues(issues)).toHaveLength(1);
    });
  });
});
