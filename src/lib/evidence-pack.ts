import { createHash } from "crypto";

/** Versioned, self-contained contract for evidence passed to both Green and Red. */
export const EVIDENCE_CONTRACT_VERSION = "evidence-contract/v1";

export type EvidenceSourceFamily =
  | "broker"
  | "congressional"
  | "filings"
  | "fundamentals"
  | "insider"
  | "learning"
  | "macro"
  | "market"
  | "news"
  | "options"
  | "policy"
  | "portfolio"
  | "technical"
  | "other";

export type EvidenceSourceStatus = "success" | "no_data" | "failed" | "partial" | "stale";

const SOURCE_FAMILIES: readonly EvidenceSourceFamily[] = [
  "broker", "congressional", "filings", "fundamentals", "insider", "learning", "macro",
  "market", "news", "options", "policy", "portfolio", "technical", "other"
];
const SOURCE_STATUSES: readonly EvidenceSourceStatus[] = ["success", "no_data", "failed", "partial", "stale"];

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface EvidenceProvenance {
  /** The immediate provider or system that supplied this observation. */
  readonly provider: string;
  /** Stable upstream identifier, URL, accession, or query fingerprint when available. */
  readonly locator: string | null;
  /** Hash supplied by the upstream source, if one exists. */
  readonly upstreamHash: string | null;
  /** Ordered source lineage, nearest upstream first. */
  readonly lineage: readonly string[];
}

export interface EvidenceSource {
  readonly family: EvidenceSourceFamily;
  readonly name: string;
  readonly status: EvidenceSourceStatus;
  /** When the underlying event or value was observed. */
  readonly observedAt: string | null;
  /** Point-in-time at which the fact was true/effective. */
  readonly asOf: string | null;
  /** When this application obtained the source response. */
  readonly retrievedAt: string | null;
  readonly provenance: EvidenceProvenance;
}

export interface EvidenceRefInput {
  /** Stable semantic category such as `quote`, `sec-filing`, or `broker-position`. */
  readonly kind: string;
  /** Subject the evidence describes, such as a canonical ticker or account scope. */
  readonly subject: string;
  readonly source: EvidenceSource;
  /** The complete structured claim used by a decision stage. */
  readonly content: JsonValue;
}

export interface EvidenceRef extends EvidenceRefInput {
  readonly id: string;
  readonly contentHash: string;
}

export interface EvidencePackInput {
  /** Caller-owned deterministic decision/run identifier; never generated here. */
  readonly decisionKey: string;
  readonly evidence: readonly EvidenceRef[];
}

export interface EvidencePack {
  readonly contractVersion: typeof EVIDENCE_CONTRACT_VERSION;
  readonly decisionKey: string;
  /** Canonically sorted by EvidenceRef id, never insertion order. */
  readonly evidence: readonly EvidenceRef[];
  /** SHA-256 of the complete canonical pack representation. */
  readonly packHash: string;
  /** SHA-256 of the evidence manifest shared verbatim with Green and Red. */
  readonly greenRedParityHash: string;
}

export interface EvidenceParityReceipt {
  readonly matches: boolean;
  readonly expectedParityHash: string;
  readonly actualParityHash: string;
}

function assertNonBlank(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must be non-blank`);
}

function assertTimestamp(value: string | null, label: string): void {
  if (value === null) return;
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO-parseable timestamp or null`);
}

function assertSource(source: EvidenceSource): void {
  if (!SOURCE_FAMILIES.includes(source.family)) throw new Error(`source.family must be a supported evidence source family`);
  assertNonBlank(source.name, "source.name");
  if (!SOURCE_STATUSES.includes(source.status)) throw new Error(`source.status must be a supported evidence source status`);
  assertTimestamp(source.observedAt, "source.observedAt");
  assertTimestamp(source.asOf, "source.asOf");
  assertTimestamp(source.retrievedAt, "source.retrievedAt");
  assertNonBlank(source.provenance.provider, "source.provenance.provider");
  for (const entry of source.provenance.lineage) assertNonBlank(entry, "source.provenance.lineage entry");
}

function cloneJson(value: JsonValue, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Evidence content may not contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("Evidence content may not contain cycles");
    seen.add(value);
    const result = value.map((entry) => cloneJson(entry, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value !== "object") throw new Error("Evidence content must be JSON serializable");
  if (seen.has(value)) throw new Error("Evidence content may not contain cycles");
  seen.add(value);
  const result: Record<string, JsonValue> = {};
  const object = value as { readonly [key: string]: JsonValue };
  for (const key of Object.keys(object)) result[key] = cloneJson(object[key]!, seen);
  seen.delete(value);
  return result;
}

function canonicalize(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key]!)}`)
    .join(",")}}`;
}

function digest(serialized: string): string {
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as object)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function immutableSource(source: EvidenceSource): EvidenceSource {
  assertSource(source);
  return deepFreeze({
    family: source.family,
    name: source.name,
    status: source.status,
    observedAt: source.observedAt,
    asOf: source.asOf,
    retrievedAt: source.retrievedAt,
    provenance: {
      provider: source.provenance.provider,
      locator: source.provenance.locator,
      upstreamHash: source.provenance.upstreamHash,
      lineage: [...source.provenance.lineage]
    }
  });
}

function refIdentity(input: Omit<EvidenceRef, "id" | "contentHash">): JsonValue {
  return {
    contractVersion: EVIDENCE_CONTRACT_VERSION,
    kind: input.kind,
    subject: input.subject,
    source: input.source as unknown as JsonValue,
    content: input.content
  };
}

/**
 * Makes a stable, immutable evidence ref. IDs are content-addressed: no clock,
 * random UUID, database sequence, or insertion order participates in identity.
 */
export function createEvidenceRef(input: EvidenceRefInput): EvidenceRef {
  assertNonBlank(input.kind, "kind");
  assertNonBlank(input.subject, "subject");
  const source = immutableSource(input.source);
  const content = deepFreeze(cloneJson(input.content));
  const identity = refIdentity({ kind: input.kind, subject: input.subject, source, content });
  const serialized = canonicalize(identity);
  const contentHash = digest(canonicalize(content));
  return deepFreeze({ id: `ev_${digest(serialized)}`, contentHash, kind: input.kind, subject: input.subject, source, content });
}

function refManifest(ref: EvidenceRef): JsonValue {
  return { id: ref.id, contentHash: ref.contentHash };
}

function parityManifest(decisionKey: string, evidence: readonly EvidenceRef[]): JsonValue {
  return {
    contractVersion: EVIDENCE_CONTRACT_VERSION,
    decisionKey,
    evidence: evidence.map(refManifest)
  };
}

/** Builds one canonical, immutable evidence manifest for both decision stages. */
export function createEvidencePack(input: EvidencePackInput): EvidencePack {
  assertNonBlank(input.decisionKey, "decisionKey");
  const evidence = input.evidence
    .map((ref) => {
      const rebuilt = createEvidenceRef(ref);
      if (rebuilt.id !== ref.id || rebuilt.contentHash !== ref.contentHash) {
        throw new Error(`EvidenceRef ${ref.id} failed integrity validation`);
      }
      return rebuilt;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set<string>();
  for (const ref of evidence) {
    if (ids.has(ref.id)) throw new Error(`EvidencePack cannot contain duplicate ref ${ref.id}`);
    ids.add(ref.id);
  }
  const parity = parityManifest(input.decisionKey, evidence);
  const greenRedParityHash = digest(canonicalize(parity));
  const packBody: JsonValue = {
    contractVersion: EVIDENCE_CONTRACT_VERSION,
    decisionKey: input.decisionKey,
    evidence: evidence.map((ref) => ({
      id: ref.id,
      contentHash: ref.contentHash,
      kind: ref.kind,
      subject: ref.subject,
      source: ref.source as unknown as JsonValue,
      content: ref.content
    })),
    greenRedParityHash
  };
  return deepFreeze({
    contractVersion: EVIDENCE_CONTRACT_VERSION,
    decisionKey: input.decisionKey,
    evidence: [...evidence],
    packHash: digest(canonicalize(packBody)),
    greenRedParityHash
  });
}

/** A canonical, key-sorted serialization suitable for audit persistence or LLM handoff. */
export function serializeEvidencePack(pack: EvidencePack): string {
  const rebuilt = createEvidencePack(pack);
  if (rebuilt.packHash !== pack.packHash || rebuilt.greenRedParityHash !== pack.greenRedParityHash) {
    throw new Error("EvidencePack failed integrity validation");
  }
  return canonicalize({
    contractVersion: pack.contractVersion,
    decisionKey: pack.decisionKey,
    evidence: pack.evidence.map((ref) => ({
      id: ref.id,
      contentHash: ref.contentHash,
      kind: ref.kind,
      subject: ref.subject,
      source: ref.source as unknown as JsonValue,
      content: ref.content
    })),
    packHash: pack.packHash,
    greenRedParityHash: pack.greenRedParityHash
  });
}

/** Compares the immutable manifests, not summaries or prompt text. */
export function compareGreenRedParity(expected: EvidencePack, actual: EvidencePack): EvidenceParityReceipt {
  return deepFreeze({
    matches: expected.greenRedParityHash === actual.greenRedParityHash,
    expectedParityHash: expected.greenRedParityHash,
    actualParityHash: actual.greenRedParityHash
  });
}
