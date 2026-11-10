import { createHash } from "node:crypto";

export const SEC_UNIVERSE_SCHEMA_VERSION = 2 as const;

export const SEC_UNIVERSE_SECURITY_TYPES = ["operating-company", "foreign-private-issuer"] as const;
export type SecUniverseSecurityType = (typeof SEC_UNIVERSE_SECURITY_TYPES)[number];

export const SEC_UNIVERSE_INCLUSION_REASONS = [
  "research-priority",
  "index-member",
  "market-cap-liquidity",
  "explicit-owner-request"
] as const;
export type SecUniverseInclusionReason = (typeof SEC_UNIVERSE_INCLUSION_REASONS)[number];

// Machine-checkable marker for whether exchange/marketCapUsd/dollarVolumeUsd are genuine
// measurements ("live") or converter placeholders/sentinels ("sentinel", e.g. exchange:"UNKNOWN",
// marketCapUsd:1, dollarVolumeUsd:1 — see convert-universe-manifest-v1-to-v2.ts). Introduced
// 2026-07-19 so downstream consumers can distinguish the two without re-deriving the
// exchange==="UNKNOWN"-and-cap===1 heuristic by hand.
export const SEC_UNIVERSE_DATA_QUALITIES = ["sentinel", "live"] as const;
export type SecUniverseDataQuality = (typeof SEC_UNIVERSE_DATA_QUALITIES)[number];

export interface SecUniverseSourceReceipt {
  name: string;
  asOf: string;
  sha256: string;
}

export interface SecUniverseIssuer {
  rank: number;
  cik: string;
  ticker: string;
  aliases: string[];
  aliasesVerifiedAt: string;
  title: string;
  exchange: string;
  securityType: SecUniverseSecurityType;
  sector: string | null;
  industry: string | null;
  marketCapUsd: number;
  dollarVolumeUsd: number;
  /** Optional for back-compat with manifests frozen before this field existed. Absent is treated
   *  as "live" (its historical implicit meaning, since every pre-existing manifest issuer was a
   *  real measurement) and the validator emits a non-blocking "warning"-severity issue rather than
   *  failing validation — see UniverseValidationIssue.severity and blockingUniverseValidationIssues. */
  dataQuality?: SecUniverseDataQuality;
  inclusionReason: SecUniverseInclusionReason;
  sourceRefs: string[];
}

export interface FrozenSecUniverseManifest {
  schemaVersion: typeof SEC_UNIVERSE_SCHEMA_VERSION;
  snapshotId: string;
  effectiveAt: string;
  generatedAt: string;
  issuerSha256: string;
  selectionMethod: string;
  sources: SecUniverseSourceReceipt[];
  issuers: SecUniverseIssuer[];
  quarantined: Array<{ ticker?: string; cik?: string; reason: string }>;
}

export interface UniverseValidationIssue {
  code: string;
  path: string;
  message: string;
  /** Absent (the default) means "error" — unchanged meaning for every pre-existing issue code.
   *  "warning" issues are advisory only (e.g. a backward-compatible default was applied) and must
   *  NOT be treated as blocking — callers that gate on issue count should filter with
   *  blockingUniverseValidationIssues() first. */
  severity?: "error" | "warning";
}

/** Issues that should actually block acceptance of a manifest — every "error"-severity issue
 *  (severity absent counts as "error", matching every pre-existing issue code). Callers that used
 *  to gate on `issues.length > 0` should switch to `blockingUniverseValidationIssues(issues).length
 *  > 0` so an advisory "warning" (e.g. a missing-but-back-compat-tolerated dataQuality) never
 *  fails a manifest that is otherwise valid. */
export function blockingUniverseValidationIssues(issues: UniverseValidationIssue[]): UniverseValidationIssue[] {
  return issues.filter((issue) => issue.severity !== "warning");
}

const CIK_RE = /^\d{10}$/;
const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/i;
const SECURITY_TYPES = new Set<string>(SEC_UNIVERSE_SECURITY_TYPES);
const INCLUSION_REASONS = new Set<string>(SEC_UNIVERSE_INCLUSION_REASONS);
const DATA_QUALITIES = new Set<string>(SEC_UNIVERSE_DATA_QUALITIES);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validDate(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  const dateOnly = value.match(DATE_ONLY_RE);
  const dateTime = value.match(DATE_TIME_RE);
  const match = dateOnly ?? dateTime;
  if (!match) return false;

  // Validate the calendar components in the ORIGINAL offset-local timestamp. Comparing the
  // date to toISOString() would incorrectly reject a valid offset that crosses a UTC day.
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) return false;
  if (!dateTime) return true;

  const hour = Number(dateTime[4]);
  const minute = Number(dateTime[5]);
  const second = Number(dateTime[6]);
  const offsetHour = Number(dateTime[9] ?? 0);
  const offsetMinute = Number(dateTime[10] ?? 0);
  if (
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 14 || offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) return false;
  return Number.isFinite(Date.parse(value));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hashSecUniverseIssuers(issuers: SecUniverseIssuer[] | unknown[]): string {
  return createHash("sha256").update(canonicalJson(issuers), "utf8").digest("hex");
}

export function validateSecUniverseManifest(
  value: unknown,
  options: { expectedIssuerCount?: number } = {}
): UniverseValidationIssue[] {
  const expectedIssuerCount = options.expectedIssuerCount ?? 1_000;
  const issues: UniverseValidationIssue[] = [];
  const add = (code: string, path: string, message: string, severity?: "warning") =>
    issues.push(severity ? { code, path, message, severity } : { code, path, message });

  if (!isObject(value)) {
    add("manifest_shape", "$", "manifest must be a versioned object, not a bare issuer array");
    return issues;
  }
  if (value.schemaVersion !== SEC_UNIVERSE_SCHEMA_VERSION) {
    add("schema_version", "$.schemaVersion", `expected ${SEC_UNIVERSE_SCHEMA_VERSION}`);
  }
  if (!nonEmptyString(value.snapshotId)) add("snapshot_id", "$.snapshotId", "snapshotId is required");
  if (!validDate(value.effectiveAt)) add("effective_at", "$.effectiveAt", "effectiveAt must be an ISO date/time");
  if (!validDate(value.generatedAt)) add("generated_at", "$.generatedAt", "generatedAt must be an ISO date/time");
  if (!nonEmptyString(value.selectionMethod)) add("selection_method", "$.selectionMethod", "selectionMethod is required");

  const sources = Array.isArray(value.sources) ? value.sources : [];
  if (sources.length === 0) add("sources", "$.sources", "at least one source receipt is required");
  const sourceNames = new Set<string>();
  sources.forEach((source, index) => {
    const path = `$.sources[${index}]`;
    if (!isObject(source)) {
      add("source_shape", path, "source receipt must be an object");
      return;
    }
    if (!nonEmptyString(source.name)) add("source_name", `${path}.name`, "source name is required");
    else if (sourceNames.has(source.name)) add("source_duplicate", `${path}.name`, "source names must be unique");
    else sourceNames.add(source.name);
    if (!validDate(source.asOf)) add("source_as_of", `${path}.asOf`, "source asOf must be an ISO date/time");
    if (typeof source.sha256 !== "string" || !SHA256_RE.test(source.sha256)) {
      add("source_sha256", `${path}.sha256`, "source sha256 must be 64 lowercase hex characters");
    }
  });

  if (!Array.isArray(value.quarantined)) {
    add("quarantine_shape", "$.quarantined", "quarantined must be an explicit array, even when empty");
  } else {
    value.quarantined.forEach((entry: unknown, index: number) => {
      const path = `$.quarantined[${index}]`;
      if (!isObject(entry)) {
        add("quarantine_entry_shape", path, "each quarantined entry must be an object");
        return;
      }
      if (!nonEmptyString(entry.reason)) {
        add("quarantine_reason", `${path}.reason`, "reason is required and must be non-empty");
      }
      if (entry.ticker !== undefined && (typeof entry.ticker !== "string" || !TICKER_RE.test(entry.ticker))) {
        add("quarantine_ticker", `${path}.ticker`, "ticker must be normalized uppercase when present");
      }
      if (entry.cik !== undefined && (typeof entry.cik !== "string" || !CIK_RE.test(entry.cik))) {
        add("quarantine_cik", `${path}.cik`, "cik must be exactly 10 digits when present");
      }
    });
  }

  const issuers = Array.isArray(value.issuers) ? value.issuers : [];
  if (!Array.isArray(value.issuers)) add("issuers_shape", "$.issuers", "issuers must be an array");
  if (issuers.length !== expectedIssuerCount) {
    add("issuer_count", "$.issuers", `expected exactly ${expectedIssuerCount} issuers, received ${issuers.length}`);
  }

  const ciks = new Set<string>();
  const tickers = new Map<string, string>();
  issuers.forEach((issuer, index) => {
    const path = `$.issuers[${index}]`;
    if (!isObject(issuer)) {
      add("issuer_shape", path, "issuer must be an object");
      return;
    }
    if (issuer.rank !== index + 1) add("rank", `${path}.rank`, `rank must be contiguous and equal ${index + 1}`);
    const cik = typeof issuer.cik === "string" ? issuer.cik : "";
    if (!CIK_RE.test(cik)) add("cik", `${path}.cik`, "CIK must be exactly 10 digits");
    else if (ciks.has(cik)) add("cik_duplicate", `${path}.cik`, `duplicate CIK ${cik}`);
    else ciks.add(cik);

    const primaryTicker = typeof issuer.ticker === "string" ? issuer.ticker : "";
    if (!TICKER_RE.test(primaryTicker)) add("ticker", `${path}.ticker`, "ticker must be normalized uppercase");
    if (!nonEmptyString(issuer.title)) add("title", `${path}.title`, "issuer title is required");
    if (!nonEmptyString(issuer.exchange)) add("exchange", `${path}.exchange`, "exchange is required");
    if (typeof issuer.securityType !== "string" || !SECURITY_TYPES.has(issuer.securityType)) {
      add("security_type", `${path}.securityType`, "only operating companies and foreign private issuers are eligible");
    }
    if (!("sector" in issuer) || !(issuer.sector === null || typeof issuer.sector === "string")) {
      add("sector", `${path}.sector`, "sector must be present as a string or null");
    }
    if (!("industry" in issuer) || !(issuer.industry === null || typeof issuer.industry === "string")) {
      add("industry", `${path}.industry`, "industry must be present as a string or null");
    }
    if (typeof issuer.marketCapUsd !== "number" || !Number.isFinite(issuer.marketCapUsd) || issuer.marketCapUsd <= 0) {
      add("market_cap", `${path}.marketCapUsd`, "marketCapUsd must be a positive finite number");
    }
    if (typeof issuer.dollarVolumeUsd !== "number" || !Number.isFinite(issuer.dollarVolumeUsd) || issuer.dollarVolumeUsd <= 0) {
      add("dollar_volume", `${path}.dollarVolumeUsd`, "dollarVolumeUsd must be a positive finite number");
    }
    if (issuer.dataQuality === undefined) {
      add(
        "data_quality_missing",
        `${path}.dataQuality`,
        "dataQuality is absent; treated as \"live\" for backward compatibility with manifests frozen before this field existed — new/updated manifests should stamp it explicitly",
        "warning"
      );
    } else if (typeof issuer.dataQuality !== "string" || !DATA_QUALITIES.has(issuer.dataQuality)) {
      add("data_quality", `${path}.dataQuality`, "dataQuality must be \"sentinel\" or \"live\" when present");
    }
    if (typeof issuer.inclusionReason !== "string" || !INCLUSION_REASONS.has(issuer.inclusionReason)) {
      add("inclusion_reason", `${path}.inclusionReason`, "inclusionReason must use a supported, non-sensitive category");
    }
    if (!validDate(issuer.aliasesVerifiedAt)) {
      add("aliases_verified_at", `${path}.aliasesVerifiedAt`, "aliasesVerifiedAt must be an ISO date/time");
    }
    if (!Array.isArray(issuer.aliases)) {
      add("aliases", `${path}.aliases`, "aliases must be an explicit array, even when empty");
    }
    const aliases = Array.isArray(issuer.aliases) ? issuer.aliases : [];
    const localAliases = new Set<string>();
    for (const [aliasIndex, aliasValue] of aliases.entries()) {
      const alias = typeof aliasValue === "string" ? aliasValue : "";
      if (!TICKER_RE.test(alias)) add("alias", `${path}.aliases[${aliasIndex}]`, "alias must be normalized uppercase");
      if (alias === primaryTicker) add("alias_primary", `${path}.aliases[${aliasIndex}]`, "primary ticker must not repeat in aliases");
      if (localAliases.has(alias)) add("alias_duplicate", `${path}.aliases[${aliasIndex}]`, `duplicate alias ${alias}`);
      localAliases.add(alias);
    }
    if (!Array.isArray(issuer.sourceRefs) || issuer.sourceRefs.length === 0) {
      add("source_refs", `${path}.sourceRefs`, "at least one source reference is required");
    } else {
      for (const [sourceIndex, sourceRef] of issuer.sourceRefs.entries()) {
        if (typeof sourceRef !== "string" || !sourceNames.has(sourceRef)) {
          add("source_ref", `${path}.sourceRefs[${sourceIndex}]`, `unknown source reference ${String(sourceRef)}`);
        }
      }
    }

    for (const ticker of [primaryTicker, ...aliases]) {
      if (!ticker) continue;
      const priorCik = tickers.get(ticker);
      if (priorCik && priorCik !== cik) add("ticker_cross_cik", path, `${ticker} maps to both ${priorCik} and ${cik}`);
      else tickers.set(ticker, cik);
    }
  });

  if (typeof value.issuerSha256 !== "string" || !SHA256_RE.test(value.issuerSha256)) {
    add("issuer_sha256", "$.issuerSha256", "issuerSha256 must be 64 lowercase hex characters");
  } else if (value.issuerSha256 !== hashSecUniverseIssuers(issuers)) {
    add("issuer_sha256_mismatch", "$.issuerSha256", "issuerSha256 does not match canonical issuer content");
  }

  return issues;
}
