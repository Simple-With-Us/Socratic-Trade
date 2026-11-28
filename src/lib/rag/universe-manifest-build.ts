// universe-manifest-build.ts — the pure assembly step behind
// scripts/eval/generate-universe-manifest.ts.
//
// ST-4690 (A4e): the generator used to be a single monolith that wrote whatever its fetch loop
// produced. Two consequences made a fresh live run produce an artifact the rest of the pipeline
// cannot trust:
//   1. An issuer whose CIK was missing from SEC's company_tickers_exchange.json was written with
//      exchange:"UNKNOWN" and dataQuality:"live" — a sentinel row wearing the live marker.
//   2. Issuers with no usable quote were dropped AFTER the 1,000 cap, so the run could write a
//      sub-1,000 manifest. The ingest seeder validates with the default expectedIssuerCount of
//      1,000 and refuses such a file outright, so a "successful" live run could not be loaded.
// This module fixes both by construction: an issuer is emitted only with a verified listing
// exchange and a real quote, quarantine drops are BACKFILLED from the ordered SEC list until the
// target count is reached, and the finished manifest is validated with the same default the
// seeder enforces before anything is written. It never fabricates a placeholder; when the target
// cannot be reached it throws instead of writing a degraded artifact.
//
// Keeping this pure (no network, no DB, no fs) is deliberate: the generator owns fetching and
// file IO, and the unit suite pins the assembly invariants without network access.

import {
  SEC_UNIVERSE_SCHEMA_VERSION,
  blockingUniverseValidationIssues,
  hashSecUniverseIssuers,
  validateSecUniverseManifest,
  type FrozenSecUniverseManifest,
  type SecUniverseInclusionReason,
  type SecUniverseIssuer,
  type SecUniverseSourceReceipt
} from "./universe-manifest";

/** SEC's company_tickers.json row, already normalized to the manifest's ticker/CIK shapes. */
export interface SecTickerRow {
  cik: string;
  ticker: string;
  title: string;
}

/** One symbol's real measurements from the market-data source. No placeholder is representable. */
export interface SecMarketDatum {
  price: number;
  volume: number;
  marketCap: number;
  sector: string | null;
  industry: string | null;
}

export interface BuildSecUniverseManifestInput {
  /** SEC company_tickers.json rows in the file's own prominence order. */
  secRows: SecTickerRow[];
  /** CIK (10 digits) -> listing exchange from SEC's company_tickers_exchange.json. */
  cikToExchange: ReadonlyMap<string, string>;
  /** Normalized ticker -> real quote measurements. */
  marketByTicker: ReadonlyMap<string, SecMarketDatum>;
  /** Symbols from the local trading/watch history (Tranche 1, research-priority). */
  dbSymbols?: Iterable<string>;
  /** S&P 500 / Nasdaq-100 / Dow-30 symbols (Tranche 2, index-member). */
  indexSymbols?: Iterable<string>;
  sources: SecUniverseSourceReceipt[];
  /** Defaults to now. */
  generatedAt?: string;
  /** Defaults to `sec-rag-<YYYY-MM-DD>`. */
  snapshotId?: string;
  /** Defaults to 1,000 — the count the ingest seeder's validator enforces. */
  targetIssuerCount?: number;
  selectionMethod: string;
}

export interface BuildSecUniverseManifestStats {
  emitted: number;
  quarantined: number;
  researchPriority: number;
  indexMember: number;
  marketCapLiquidity: number;
  /** How many emitted issuers carry a non-null sector (the quarantine rule does not require it). */
  withSector: number;
  quarantineReasons: Record<string, number>;
}

export interface BuildSecUniverseManifestResult {
  manifest: FrozenSecUniverseManifest;
  stats: BuildSecUniverseManifestStats;
}

const CIK_RE = /^\d{10}$/;
// Mirrors the validator's TICKER_RE (src/lib/rag/universe-manifest.ts) so a ticker SEC accepts
// but the manifest schema rejects is quarantined here instead of failing validation later.
const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const UNKNOWN_EXCHANGE = "UNKNOWN";
export const DEFAULT_TARGET_ISSUER_COUNT = 1_000;

/** Our canonical symbol format hyphenates share classes (BRK-B); Nasdaq writes BRK/B or BRK.B. */
export function normalizeManifestTicker(ticker: string): string {
  return String(ticker ?? "").trim().toUpperCase().replace(/[./]/g, "-");
}

function normalizeCik(cik: string | number): string {
  return String(cik ?? "").trim().padStart(10, "0");
}

function usableMarket(datum: SecMarketDatum | undefined): datum is SecMarketDatum {
  if (!datum) return false;
  return (
    Number.isFinite(datum.price) &&
    datum.price > 0 &&
    Number.isFinite(datum.volume) &&
    datum.volume > 0 &&
    Number.isFinite(datum.marketCap) &&
    datum.marketCap > 0
  );
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

interface Candidate {
  cik: string;
  ticker: string;
  title: string;
  reason: SecUniverseInclusionReason;
}

/**
 * Build the ordered candidate list: DB history, then index membership, then the full SEC list in
 * prominence order. The list is NOT capped here — the emission step walks it and stops at the
 * target, so a quarantined candidate costs nothing but is replaced by the next honest one.
 */
function buildCandidates(
  secRows: SecTickerRow[],
  dbSymbols: Iterable<string>,
  indexSymbols: Iterable<string>
): { candidates: Candidate[]; tickerToCik: Map<string, string>; unmappedSymbols: Array<{ ticker: string; reason: string }> } {
  const tickerToCik = new Map<string, string>();
  const conflictingTickers = new Set<string>();
  const titleByCik = new Map<string, string>();
  for (const row of secRows) {
    const ticker = normalizeManifestTicker(row.ticker);
    const cik = normalizeCik(row.cik);
    if (!ticker || !CIK_RE.test(cik)) continue;
    const prior = tickerToCik.get(ticker);
    if (prior !== undefined && prior !== cik) {
      // SEC re-listing an old ticker under a new CIK: neither claim is safe to emit.
      conflictingTickers.add(ticker);
      continue;
    }
    tickerToCik.set(ticker, cik);
    if (!titleByCik.has(cik)) titleByCik.set(cik, row.title);
  }
  for (const ticker of conflictingTickers) tickerToCik.delete(ticker);

  const candidates: Candidate[] = [];
  const queuedCiks = new Set<string>();
  const unmappedSymbols: Array<{ ticker: string; reason: string }> = [];
  // Kody 68-kk4: the same ticker can arrive unmapped through several tranches (a DB-history
  // symbol that is also an index member, say).  Quarantine it ONCE — duplicate pushes inflated
  // stats.quarantined and emitted redundant manifest rows for one missing issuer.
  const unmappedTickers = new Set<string>();

  const queueSymbols = (symbols: Iterable<string>, reason: SecUniverseInclusionReason, label: string) => {
    for (const raw of symbols) {
      const ticker = normalizeManifestTicker(raw);
      if (!ticker) continue;
      const cik = tickerToCik.get(ticker);
      if (!cik) {
        if (!unmappedTickers.has(ticker)) {
          unmappedTickers.add(ticker);
          unmappedSymbols.push({ ticker, reason: `${label} ticker is not in SEC company_tickers.json` });
        }
        continue;
      }
      if (queuedCiks.has(cik)) continue;
      queuedCiks.add(cik);
      candidates.push({ cik, ticker, title: titleByCik.get(cik) ?? "", reason });
    }
  };

  queueSymbols(dbSymbols, "research-priority", "DB history");
  queueSymbols(indexSymbols, "index-member", "Index membership");
  for (const row of secRows) {
    const cik = normalizeCik(row.cik);
    const ticker = normalizeManifestTicker(row.ticker);
    if (!CIK_RE.test(cik) || !ticker || !tickerToCik.has(ticker)) continue;
    if (queuedCiks.has(cik)) continue;
    queuedCiks.add(cik);
    candidates.push({ cik, ticker, title: row.title, reason: "market-cap-liquidity" });
  }

  return { candidates, tickerToCik, unmappedSymbols };
}

/**
 * Assemble a validated FrozenSecUniverseManifest from already-fetched inputs.
 *
 * Throws (never writes a degraded artifact) when fewer than `targetIssuerCount` issuers have both
 * a verified exchange and a real quote, or when the finished manifest fails the same validation
 * the ingest seeder applies.
 */
export function buildSecUniverseManifest(input: BuildSecUniverseManifestInput): BuildSecUniverseManifestResult {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const target = input.targetIssuerCount ?? DEFAULT_TARGET_ISSUER_COUNT;
  const sourceNames = input.sources.map((source) => source.name);
  if (sourceNames.length === 0) throw new Error("buildSecUniverseManifest needs at least one source receipt.");
  if (new Set(sourceNames).size !== sourceNames.length) throw new Error("Source receipt names must be unique.");

  const { candidates, tickerToCik, unmappedSymbols } = buildCandidates(
    input.secRows,
    input.dbSymbols ?? [],
    input.indexSymbols ?? []
  );

  // Aliases for a CIK: every SEC ticker that maps to the same CIK (GOOG/GOOGL), excluding the
  // primary. The claim map keeps a ticker from being both another issuer's primary and an alias.
  const tickersByCik = new Map<string, string[]>();
  for (const [ticker, cik] of tickerToCik) {
    const list = tickersByCik.get(cik) ?? [];
    list.push(ticker);
    tickersByCik.set(cik, list);
  }

  const issuers: SecUniverseIssuer[] = [];
  const quarantined: Array<{ cik?: string; ticker?: string; reason: string }> = [];
  const quarantineReasons: Record<string, number> = {};
  const noteQuarantine = (reason: string, ticker?: string, cik?: string) => {
    quarantineReasons[reason] = (quarantineReasons[reason] ?? 0) + 1;
    quarantined.push({ cik, ticker, reason });
  };
  for (const entry of unmappedSymbols) noteQuarantine(entry.reason, entry.ticker);
  const claimedTickers = new Map<string, string>();

  for (const candidate of candidates) {
    if (issuers.length >= target) break;
    if (!CIK_RE.test(candidate.cik)) {
      noteQuarantine("CIK is not exactly 10 digits", candidate.ticker, candidate.cik);
      continue;
    }
    if (!candidate.title || !candidate.title.trim()) {
      noteQuarantine("SEC company_tickers.json has no issuer title", candidate.ticker, candidate.cik);
      continue;
    }
    if (!TICKER_RE.test(candidate.ticker)) {
      noteQuarantine("ticker is not in the manifest schema's normalized shape", candidate.ticker, candidate.cik);
      continue;
    }
    const exchange = trimmedOrNull(input.cikToExchange.get(candidate.cik));
    if (!exchange || exchange.toUpperCase() === UNKNOWN_EXCHANGE) {
      noteQuarantine("no verified listing exchange in SEC company_tickers_exchange.json", candidate.ticker, candidate.cik);
      continue;
    }
    const market = input.marketByTicker.get(candidate.ticker);
    if (!usableMarket(market)) {
      noteQuarantine("no usable market quote (price/volume/market-cap) at generation time", candidate.ticker, candidate.cik);
      continue;
    }
    const primaryClaim = claimedTickers.get(candidate.ticker);
    if (primaryClaim !== undefined && primaryClaim !== candidate.cik) {
      noteQuarantine("ticker is already claimed by another CIK", candidate.ticker, candidate.cik);
      continue;
    }

    const aliases: string[] = [];
    for (const alias of tickersByCik.get(candidate.cik) ?? []) {
      if (alias === candidate.ticker) continue;
      if (!TICKER_RE.test(alias)) continue;
      const aliasClaim = claimedTickers.get(alias);
      if (aliasClaim !== undefined && aliasClaim !== candidate.cik) continue;
      if (aliases.includes(alias)) continue;
      aliases.push(alias);
      claimedTickers.set(alias, candidate.cik);
    }
    claimedTickers.set(candidate.ticker, candidate.cik);

    issuers.push({
      rank: 0, // assigned after the loop so ranks stay contiguous
      cik: candidate.cik,
      ticker: candidate.ticker,
      aliases,
      aliasesVerifiedAt: generatedAt,
      title: candidate.title,
      exchange: exchange.toUpperCase(),
      // FPI (20-F/40-F) detection needs a per-CIK submissions probe this generator does not do;
      // a wrongly-tagged FPI only means 10-K/10-Q discovery finds nothing for it.
      securityType: "operating-company",
      sector: trimmedOrNull(market.sector),
      industry: trimmedOrNull(market.industry),
      marketCapUsd: market.marketCap,
      dollarVolumeUsd: market.price * market.volume,
      dataQuality: "live",
      inclusionReason: candidate.reason,
      sourceRefs: sourceNames
    });
  }

  if (issuers.length < target) {
    const firstReasons = Object.entries(quarantineReasons)
      .map(([reason, count]) => `${count}x ${reason}`)
      .join("; ");
    throw new Error(
      `Only ${issuers.length} issuer(s) had both a verified listing exchange and a real market quote; ` +
        `the manifest contract requires ${target}. Refusing to write a degraded universe.` +
        (firstReasons ? ` Quarantine reasons: ${firstReasons}.` : "")
    );
  }

  issuers.forEach((issuer, index) => {
    issuer.rank = index + 1;
  });

  const snapshotId = input.snapshotId ?? `sec-rag-${generatedAt.slice(0, 10)}`;
  const manifest: FrozenSecUniverseManifest = {
    schemaVersion: SEC_UNIVERSE_SCHEMA_VERSION,
    snapshotId,
    effectiveAt: generatedAt,
    generatedAt,
    issuerSha256: hashSecUniverseIssuers(issuers),
    selectionMethod: input.selectionMethod,
    sources: input.sources,
    issuers,
    quarantined
  };

  // Validate against the count this build promised. The generator always asks for 1,000, which is
  // also the seeder's default expectedIssuerCount — so a manifest it writes is one the seeder
  // will load. A smaller explicit target is validated as such.
  const issues = blockingUniverseValidationIssues(
    validateSecUniverseManifest(manifest, { expectedIssuerCount: target })
  );
  if (issues.length > 0) {
    const detail = issues
      .slice(0, 20)
      .map((issue) => `${issue.code} ${issue.path}: ${issue.message}`)
      .join("; ");
    throw new Error(`Generated manifest failed schema validation (${issues.length} issue(s)): ${detail}`);
  }
  const sentinelShaped = issuers.find(
    (issuer) => issuer.dataQuality !== "live" || issuer.exchange === UNKNOWN_EXCHANGE
  );
  if (sentinelShaped) {
    throw new Error(
      `Generated manifest contains a sentinel-shaped issuer (${sentinelShaped.ticker}: ` +
        `dataQuality=${String(sentinelShaped.dataQuality)}, exchange=${sentinelShaped.exchange}).`
    );
  }

  const stats: BuildSecUniverseManifestStats = {
    emitted: issuers.length,
    quarantined: quarantined.length,
    researchPriority: issuers.filter((issuer) => issuer.inclusionReason === "research-priority").length,
    indexMember: issuers.filter((issuer) => issuer.inclusionReason === "index-member").length,
    marketCapLiquidity: issuers.filter((issuer) => issuer.inclusionReason === "market-cap-liquidity").length,
    withSector: issuers.filter((issuer) => issuer.sector !== null).length,
    quarantineReasons
  };
  return { manifest, stats };
}