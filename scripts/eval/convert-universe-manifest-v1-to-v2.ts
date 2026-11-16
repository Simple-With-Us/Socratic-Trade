import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  SEC_UNIVERSE_SCHEMA_VERSION,
  blockingUniverseValidationIssues,
  hashSecUniverseIssuers,
  validateSecUniverseManifest,
  type FrozenSecUniverseManifest,
  type SecUniverseIssuer,
  type SecUniverseInclusionReason
} from "../../src/lib/rag/universe-manifest";

// One-time, network-free conversion of the legacy bare-array data/rag-universe-manifest.json
// (1,000 issuers, frozen 2026-07-12 in #1495) into the versioned FrozenSecUniverseManifest shape
// validateSecUniverseManifest requires. This is a pure local transform of already-committed data —
// it does NOT re-fetch SEC/Yahoo data (see the updated generate-universe-manifest.ts for the script
// that does a live re-generation with real exchange/market-cap sourcing).
//
// Fields the legacy array never captured (exchange, sector, industry, marketCapUsd,
// dollarVolumeUsd) are NOT re-derived here — there is no honest local source for them. Rather than
// fabricate plausible-looking numbers, this script uses explicit, unmistakable placeholders (see
// PLACEHOLDER_* below) and documents them in `selectionMethod`. A live re-generation via the
// updated script is required before exchange/market-cap-based filtering can be trusted.
//
// See docs/rollouts/2026-07-18-sec-ingest-worker-wiring.md for the full rationale.

interface LegacyUniverseEntry {
  cik: string;
  ticker: string;
  title: string;
  inclusionReason: string;
  aliases?: string[];
}

// The legacy generator used "top-prominence" as a single bucket for BOTH DB-history-derived issuers
// (deliberately masked, per its own comment, so the manifest never reveals real trade/watch history)
// AND the SEC-ticker-order fill tranche — that distinction was not preserved in the committed file,
// so both collapse to the same valid, honest replacement category here: these are prominent,
// SEC-tracked companies, which is what "top-prominence" always literally meant.
const LEGACY_INCLUSION_REASON_MAP: Record<string, SecUniverseInclusionReason> = {
  "top-prominence": "market-cap-liquidity",
  "index-member": "index-member"
};

const UNKNOWN_EXCHANGE = "UNKNOWN";
// Deliberately NOT a plausible-looking number (e.g. not "2_500_000_000") — a uniform "1" across all
// 1,000 issuers cannot be mistaken for a real measurement by any human or downstream code.
const PLACEHOLDER_MARKET_CAP_USD = 1;
const PLACEHOLDER_DOLLAR_VOLUME_USD = 1;

const LEGACY_SOURCE_NAME = "legacy-frozen-array-v1";
// Exact commit datetime the legacy array was first frozen (7400166e, "SEC/RAG Backfill: P0 — Truth
// and Census", 2026-07-12) — `git log --follow --format="%aI" -- data/rag-universe-manifest.json`.
const LEGACY_SOURCE_AS_OF = "2026-07-12T20:33:39-05:00";

function main() {
  const manifestPath = path.resolve("data/rag-universe-manifest.json");
  const raw = fs.readFileSync(manifestPath, "utf8");
  const legacySha256 = createHash("sha256").update(raw, "utf8").digest("hex");
  const legacy = JSON.parse(raw) as unknown;

  if (!Array.isArray(legacy)) {
    throw new Error(
      "Expected data/rag-universe-manifest.json to be the legacy bare issuer array; it already looks versioned. " +
      "Re-run only against the pre-conversion file."
    );
  }

  const generatedAt = new Date().toISOString();

  const issuers: SecUniverseIssuer[] = (legacy as LegacyUniverseEntry[]).map((entry, index) => {
    const mappedReason = LEGACY_INCLUSION_REASON_MAP[entry.inclusionReason];
    if (!mappedReason) {
      throw new Error(`Unmapped legacy inclusionReason "${entry.inclusionReason}" for CIK ${entry.cik} (${entry.ticker})`);
    }
    return {
      rank: index + 1,
      cik: entry.cik,
      ticker: entry.ticker,
      aliases: entry.aliases ?? [],
      aliasesVerifiedAt: generatedAt,
      title: entry.title,
      exchange: UNKNOWN_EXCHANGE,
      securityType: "operating-company",
      sector: null,
      industry: null,
      marketCapUsd: PLACEHOLDER_MARKET_CAP_USD,
      dollarVolumeUsd: PLACEHOLDER_DOLLAR_VOLUME_USD,
      // Machine-checkable marker for the sentinel/placeholder fields above (see the module comment)
      // — lets downstream consumers detect them without re-deriving the exchange==="UNKNOWN"
      // heuristic by hand.
      dataQuality: "sentinel",
      inclusionReason: mappedReason,
      sourceRefs: [LEGACY_SOURCE_NAME]
    };
  });

  const manifest: FrozenSecUniverseManifest = {
    schemaVersion: SEC_UNIVERSE_SCHEMA_VERSION,
    snapshotId: "sec-rag-1000-legacy-conversion-2026-07-18",
    effectiveAt: LEGACY_SOURCE_AS_OF,
    generatedAt,
    issuerSha256: hashSecUniverseIssuers(issuers),
    selectionMethod:
      "Legacy tranche selection (DB trading/watch history + S&P 500/Nasdaq-100/Dow-30 index " +
      "membership + SEC company_tickers.json prominence-order fill, capped at 1,000, originally " +
      "frozen 2026-07-12, #1495) converted to FrozenSecUniverseManifest schema v2 on 2026-07-18 via " +
      "a local, network-free transform (scripts/eval/convert-universe-manifest-v1-to-v2.ts). " +
      "exchange/sector/industry/marketCapUsd/dollarVolumeUsd were never captured by the legacy array " +
      "and are NOT re-derived here: exchange is the explicit sentinel \"UNKNOWN\", sector/industry " +
      "are null, and marketCapUsd/dollarVolumeUsd are the explicit placeholder value 1 (deliberately " +
      "not a plausible-looking number, so it cannot be mistaken for a real measurement). A live " +
      "re-generation via the updated generate-universe-manifest.ts is required before exchange/" +
      "market-cap-based filtering can be trusted — see docs/rollouts/2026-07-18-sec-ingest-worker-wiring.md.",
    sources: [{ name: LEGACY_SOURCE_NAME, asOf: LEGACY_SOURCE_AS_OF, sha256: legacySha256 }],
    issuers,
    quarantined: []
  };

  const issues = blockingUniverseValidationIssues(validateSecUniverseManifest(manifest, { expectedIssuerCount: issuers.length }));
  if (issues.length > 0) {
    console.error(`Converted manifest failed its own schema validation (${issues.length} issue(s)):`);
    for (const issue of issues.slice(0, 20)) console.error(`  - ${issue.code} ${issue.path}: ${issue.message}`);
    process.exit(1);
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`Converted ${issuers.length} issuers to schema v${SEC_UNIVERSE_SCHEMA_VERSION}. Wrote ${manifestPath}`);
}

main();
