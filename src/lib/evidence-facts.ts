/**
 * Source-faithful metadata for a single structured field. Values stay in their
 * existing scalar slots; this receipt makes their freshness, source, and
 * arbitration decision inspectable without changing scalar consumers.
 */
export type FieldAvailabilityStatus =
  | "ok"
  | "no_match"
  | "failed"
  | "stale"
  | "budget_degraded"
  | "not_requested";

export interface FieldConflict {
  kind: "value_disagreement" | "source_disagreement" | "stale_source";
  summary: string;
  competingSources?: string[];
}

export interface FieldObservation<T> {
  value?: T;
  source: string;
  upstreamFamily?: string;
  observedAt?: string;
  effectiveAt?: string;
  fetchedAt?: string;
  expiresAt?: string;
  asOf?: string;
  status: FieldAvailabilityStatus;
  confidence?: number;
  reliability?: number;
  directness?: number;
  conflict?: FieldConflict;
}

/**
 * Build a complete per-field provenance stamp (source + asOf + fetchedAt).
 * Prefer calling this (or cascade takeScalar) whenever a scan/cache value is accepted
 * so consumers never see bare scalars without provenance.
 * Preference ranks for *which* source to call live in `source-capability-matrix.ts`.
 */
export function stampFieldObservation<T>(
  value: T | undefined,
  source: string,
  opts?: {
    asOf?: string;
    observedAt?: string;
    effectiveAt?: string;
    fetchedAt?: string;
    status?: FieldAvailabilityStatus;
    upstreamFamily?: string;
    confidence?: number;
    reliability?: number;
    directness?: number;
  }
): FieldObservation<T> {
  const fetchedAt = opts?.fetchedAt ?? new Date().toISOString();
  const asOf = opts?.asOf ?? opts?.observedAt ?? opts?.effectiveAt ?? fetchedAt;
  const resolvedSource = source.trim() ? source : "unknown";
  return {
    value,
    source: resolvedSource,
    upstreamFamily: opts?.upstreamFamily ?? resolvedSource,
    observedAt: opts?.observedAt,
    effectiveAt: opts?.effectiveAt,
    fetchedAt,
    asOf,
    status: opts?.status ?? (value === undefined ? "no_match" : "ok"),
    confidence: opts?.confidence,
    reliability: opts?.reliability,
    directness: opts?.directness
  };
}

export interface ProviderFailureReceipt {
  source: string;
  upstreamFamily?: string;
  fetchedAt: string;
  status: "failed" | "budget_degraded";
  errorKind?: string;
}

export interface FieldObservationCandidate<T> {
  observation: FieldObservation<T>;
  providerName: string;
  registrationOrder: number;
}

export type FieldArbitrationPolicy =
  | { mode: "registration" }
  | { mode: "metadata"; priorities: ReadonlyArray<"reliability" | "directness" | "recency" | "confidence"> };

const REGISTRATION_PRIORITY_FIELDS = new Set([
  "price",
  "bid",
  "ask",
  "intradayChangePct",
  "vwap"
]);

const QUOTE_METADATA_FIELDS = new Set(["volume"]);

/** Current quote priority is intentionally registration-first for compatibility. */
export function fieldArbitrationPolicy(field: string): FieldArbitrationPolicy {
  if (REGISTRATION_PRIORITY_FIELDS.has(field)) return { mode: "registration" };
  if (QUOTE_METADATA_FIELDS.has(field)) {
    return { mode: "metadata", priorities: ["recency", "reliability", "directness", "confidence"] };
  }
  return { mode: "metadata", priorities: ["reliability", "directness", "recency", "confidence"] };
}

function availabilityRank(status: FieldAvailabilityStatus): number {
  if (status === "ok") return 2;
  if (status === "stale") return 1;
  return 0;
}

function recency(timestamp: string | undefined): number {
  if (!timestamp) return 0;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : 0;
}

function metric<T>(candidate: FieldObservationCandidate<T>, key: "reliability" | "directness" | "recency" | "confidence"): number {
  if (key === "recency") {
    return recency(candidate.observation.asOf ?? candidate.observation.observedAt ?? candidate.observation.effectiveAt ?? candidate.observation.fetchedAt);
  }
  return candidate.observation[key] ?? 0;
}

/**
 * Selects a usable observation with field-specific deterministic rules. Existing
 * providers generally have no metadata scores, so their registration order remains
 * the tie-breaker until a provider supplies a stronger receipt.
 */
export function arbitrateFieldObservation<T>(
  field: string,
  candidates: ReadonlyArray<FieldObservationCandidate<T>>
): FieldObservationCandidate<T> | undefined {
  const usable = candidates.filter((candidate) =>
    candidate.observation.value !== undefined && availabilityRank(candidate.observation.status) > 0
  );
  if (usable.length === 0) return undefined;

  const policy = fieldArbitrationPolicy(field);
  return [...usable].sort((left, right) => {
    const availability = availabilityRank(right.observation.status) - availabilityRank(left.observation.status);
    if (availability !== 0) return availability;
    if (policy.mode === "metadata") {
      for (const priority of policy.priorities) {
        const comparison = metric(right, priority) - metric(left, priority);
        if (comparison !== 0) return comparison;
      }
    }
    return left.registrationOrder - right.registrationOrder;
  })[0];
}

export interface UpstreamFamilyCandidate<T> {
  key: string;
  upstreamFamily?: string;
  value: T;
  registrationOrder: number;
}

/** Keeps the last registered read per upstream family, preserving prior overwrite semantics. */
export function dedupeUpstreamFamilies<T>(
  candidates: ReadonlyArray<UpstreamFamilyCandidate<T>>
): UpstreamFamilyCandidate<T>[] {
  const selected = new Map<string, UpstreamFamilyCandidate<T>>();
  for (const candidate of candidates) {
    selected.set(candidate.upstreamFamily ?? candidate.key, candidate);
  }
  return [...selected.values()].sort((left, right) => left.registrationOrder - right.registrationOrder);
}
