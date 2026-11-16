import fs from "node:fs";
import path from "node:path";
import {
  blockingUniverseValidationIssues,
  hashSecUniverseIssuers,
  validateSecUniverseManifest,
  type FrozenSecUniverseManifest,
  type SecUniverseIssuer
} from "../../src/lib/rag/universe-manifest";

// One-time, network-free retrofit that stamps the new `dataQuality` field (added 2026-07-19,
// verifier advisory) onto the already-versioned data/rag-universe-manifest.json produced by
// convert-universe-manifest-v1-to-v2.ts on 2026-07-18. That earlier conversion left every issuer's
// exchange/marketCapUsd/dollarVolumeUsd as explicit, unmistakable sentinels (exchange:"UNKNOWN",
// marketCapUsd:1, dollarVolumeUsd:1) with no machine-checkable marker distinguishing them from a
// real measurement. This script adds that marker, reusing the same read -> transform -> re-hash ->
// re-validate -> write pattern as convert-universe-manifest-v1-to-v2.ts (hashSecUniverseIssuers /
// validateSecUniverseManifest from src/lib/rag/universe-manifest.ts), rather than re-deriving the
// sentinel-detection logic ad hoc.
//
// This is a pure local transform — it does NOT re-fetch SEC/Yahoo data. A live re-generation via
// generate-universe-manifest.ts (which now stamps dataQuality:"live" itself) is still required
// before exchange/market-cap-based filtering can be trusted.

const STAMP_EVENT_NOTE =
  " [2026-07-19] dataQuality retroactively stamped on every issuer by " +
  "scripts/eval/stamp-universe-manifest-data-quality.ts: all 1,000 issuers matched the sentinel " +
  "pattern (exchange===\"UNKNOWN\" && marketCapUsd===1 && dollarVolumeUsd===1) and were marked " +
  "dataQuality:\"sentinel\" accordingly; issuerSha256 was recomputed over the updated issuer array.";

function isSentinelIssuer(issuer: SecUniverseIssuer): boolean {
  return issuer.exchange === "UNKNOWN" && issuer.marketCapUsd === 1 && issuer.dollarVolumeUsd === 1;
}

function main() {
  const manifestPath = path.resolve("data/rag-universe-manifest.json");
  const raw = fs.readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected ${manifestPath} to already be a versioned FrozenSecUniverseManifest object.`);
  }
  const manifest = parsed as FrozenSecUniverseManifest;

  const alreadyStamped = manifest.issuers.filter((issuer) => issuer.dataQuality !== undefined).length;
  if (alreadyStamped > 0) {
    throw new Error(
      `Refusing to re-stamp: ${alreadyStamped}/${manifest.issuers.length} issuer(s) already carry a dataQuality value. ` +
      "This script is meant to run exactly once against a manifest with no dataQuality field."
    );
  }

  const issuers: SecUniverseIssuer[] = manifest.issuers.map((issuer) => {
    // Rebuild with dataQuality positioned right after dollarVolumeUsd (matching the
    // SecUniverseIssuer field order in universe-manifest.ts) rather than appending it — purely
    // cosmetic (canonicalJson/hashSecUniverseIssuers sorts keys regardless), but keeps the
    // committed JSON readable for a human diffing it.
    const { rank, cik, ticker, aliases, aliasesVerifiedAt, title, exchange, securityType, sector, industry, marketCapUsd, dollarVolumeUsd, inclusionReason, sourceRefs } = issuer;
    return {
      rank, cik, ticker, aliases, aliasesVerifiedAt, title, exchange, securityType, sector, industry,
      marketCapUsd, dollarVolumeUsd,
      dataQuality: isSentinelIssuer(issuer) ? "sentinel" : "live",
      inclusionReason, sourceRefs
    };
  });

  const sentinelCount = issuers.filter((i) => i.dataQuality === "sentinel").length;
  const liveCount = issuers.filter((i) => i.dataQuality === "live").length;

  const stamped: FrozenSecUniverseManifest = {
    ...manifest,
    generatedAt: new Date().toISOString(),
    issuerSha256: hashSecUniverseIssuers(issuers),
    selectionMethod: manifest.selectionMethod + STAMP_EVENT_NOTE,
    issuers
  };

  const issues = blockingUniverseValidationIssues(validateSecUniverseManifest(stamped, { expectedIssuerCount: issuers.length }));
  if (issues.length > 0) {
    console.error(`Stamped manifest failed its own schema validation (${issues.length} issue(s)):`);
    for (const issue of issues.slice(0, 20)) console.error(`  - ${issue.code} ${issue.path}: ${issue.message}`);
    process.exit(1);
  }

  fs.writeFileSync(manifestPath, JSON.stringify(stamped, null, 2) + "\n", "utf8");
  console.log(
    `Stamped dataQuality on ${issuers.length} issuers (${sentinelCount} sentinel, ${liveCount} live). Wrote ${manifestPath}`
  );
}

main();
