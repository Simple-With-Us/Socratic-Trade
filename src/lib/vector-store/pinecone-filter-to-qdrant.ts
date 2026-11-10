/**
 * Pinecone metadata-filter JSON -> Qdrant filter translation (STAGE-1 read cutover).
 *
 * The Qdrant collection ("socratic-trade") holds one point per copied Pinecone vector with the
 * full Pinecone metadata as payload PLUS `pc_id` (the original Pinecone vector id) and `ns` (the
 * tenant key — one value per former Pinecone namespace; see scripts/qdrant/pinecone-to-qdrant-copy.py).
 * Retrieval keeps building Pinecone-style filters (vector-db.ts), and this module translates them
 * verbatim into Qdrant's must/should/must_not model at query time.
 *
 * SAFETY CONTRACT — refuse loudly, never drop: a silently dropped filter clause on this app can
 * leak cross-tenant data (the userId/scope/tenant_scope clauses ARE the tenant isolation).  Any
 * operator or filter shape this translator does not implement throws
 * `UnsupportedPineconeFilterError`; the read path treats that tier as failed (contributes no
 * candidates) rather than querying with a widened filter.
 *
 * `$exists: false` translation: Qdrant's `is_empty` matches points MISSING the field (also null /
 * empty array), which is the pre-backfill truth.  A planned payload backfill stamps explicit
 * sentinels onto points missing these fields so the (indexed) match arm can serve the same
 * predicate cheaply post-backfill; both arms stay OR'd so correctness holds before, during, and
 * after that backfill.  Fields without a catalogued sentinel use the `is_empty` arm alone — for a
 * field the backfill never stamps, that stays exactly right.
 */

export class UnsupportedPineconeFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPineconeFilterError";
  }
}

/** A Qdrant filter condition — either a field/is_empty condition or a nested filter object. */
export type QdrantCondition = Record<string, unknown>;

export interface QdrantFilter {
  must?: QdrantCondition[];
  should?: QdrantCondition[];
  must_not?: QdrantCondition[];
}

/**
 * Sentinel values the payload backfill stamps onto points that LACK each field, so the
 * `$exists: false` match arm can identify them by (indexed) value.  Keep this table in sync with
 * the backfill script when it lands — a sentinel listed here that the backfill does not stamp is
 * harmless (the is_empty arm still matches), but a backfill that stamps a DIFFERENT value than
 * listed here would silently shrink `$exists: false` recall post-backfill.
 */
export const ABSENT_FIELD_SENTINELS: Record<string, string | number | boolean> = {
  scope: "__absent__",
  tenant_scope: "__absent__",
  receipt_required: false,
  as_of_epoch_ms: 0
};

type Scalar = string | number | boolean;

function isScalar(value: unknown): value is Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function matchCondition(field: string, value: Scalar): QdrantCondition {
  return { key: field, match: { value } };
}

function isEmptyCondition(field: string): QdrantCondition {
  return { is_empty: { key: field } };
}

/** `$exists: false` -> is_empty OR the backfill sentinel (see module header). */
function absentFieldCondition(field: string): QdrantCondition {
  const sentinel = ABSENT_FIELD_SENTINELS[field];
  if (sentinel === undefined) return isEmptyCondition(field);
  return { should: [isEmptyCondition(field), matchCondition(field, sentinel)] };
}

const RANGE_OPS: Record<string, "lt" | "lte" | "gt" | "gte"> = {
  $lt: "lt",
  $lte: "lte",
  $gt: "gt",
  $gte: "gte"
};

/** Translate one field's Pinecone condition (`{$eq: v}`, `{$in: [...]}`, scalar shorthand, ...). */
function translateFieldCondition(field: string, spec: unknown): QdrantCondition {
  if (isScalar(spec)) return matchCondition(field, spec); // Pinecone implicit-$eq shorthand
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new UnsupportedPineconeFilterError(
      `Unsupported filter value for field "${field}": ${JSON.stringify(spec)}`
    );
  }
  const ops = Object.entries(spec as Record<string, unknown>);
  if (ops.length === 0) {
    throw new UnsupportedPineconeFilterError(`Empty operator object for field "${field}"`);
  }
  const conditions: QdrantCondition[] = [];
  const range: Record<string, number> = {};
  for (const [op, value] of ops) {
    if (op === "$eq") {
      if (!isScalar(value)) {
        throw new UnsupportedPineconeFilterError(`$eq on "${field}" expects a scalar, got ${JSON.stringify(value)}`);
      }
      conditions.push(matchCondition(field, value));
    } else if (op === "$ne") {
      if (!isScalar(value)) {
        throw new UnsupportedPineconeFilterError(`$ne on "${field}" expects a scalar, got ${JSON.stringify(value)}`);
      }
      // must_not(match) also matches points missing the field — same as Pinecone's $ne.
      conditions.push({ must_not: [matchCondition(field, value)] });
    } else if (op === "$in") {
      if (!Array.isArray(value) || value.length === 0 || !value.every(isScalar)) {
        throw new UnsupportedPineconeFilterError(`$in on "${field}" expects a non-empty scalar array, got ${JSON.stringify(value)}`);
      }
      conditions.push({ key: field, match: { any: value } });
    } else if (op in RANGE_OPS) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new UnsupportedPineconeFilterError(`${op} on "${field}" expects a finite number, got ${JSON.stringify(value)}`);
      }
      range[RANGE_OPS[op]] = value;
    } else if (op === "$exists") {
      if (typeof value !== "boolean") {
        throw new UnsupportedPineconeFilterError(`$exists on "${field}" expects a boolean, got ${JSON.stringify(value)}`);
      }
      conditions.push(value ? { must_not: [isEmptyCondition(field)] } : absentFieldCondition(field));
    } else {
      throw new UnsupportedPineconeFilterError(`Unsupported operator "${op}" on field "${field}"`);
    }
  }
  if (Object.keys(range).length > 0) conditions.push({ key: field, range });
  return conditions.length === 1 ? conditions[0] : { must: conditions };
}

/**
 * Translate a whole Pinecone filter object into ONE Qdrant condition (a nested filter).  Field
 * keys AND-combine (Pinecone top-level semantics); `$and` contributes each sub-filter to the same
 * `must`; `$or` becomes a nested `{should: [...]}` condition — so the vector-db shape
 * `{...fields, $or: [...]}` and the `$and`-of-`$or`-blocks shape both come out as
 * `must: [ ...fields, {should: [...]}, ... ]`.
 */
function translateFilterNode(filter: Record<string, unknown>): QdrantCondition {
  const must: QdrantCondition[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and") {
      if (!Array.isArray(value) || value.length === 0) {
        throw new UnsupportedPineconeFilterError(`$and expects a non-empty array, got ${JSON.stringify(value)}`);
      }
      for (const sub of value) {
        if (sub === null || typeof sub !== "object" || Array.isArray(sub)) {
          throw new UnsupportedPineconeFilterError(`$and member must be a filter object, got ${JSON.stringify(sub)}`);
        }
        const translated = translateFilterNode(sub as Record<string, unknown>);
        if (translated !== EMPTY_CONDITION) must.push(translated);
      }
    } else if (key === "$or") {
      if (!Array.isArray(value) || value.length === 0) {
        throw new UnsupportedPineconeFilterError(`$or expects a non-empty array, got ${JSON.stringify(value)}`);
      }
      const should: QdrantCondition[] = [];
      for (const sub of value) {
        if (sub === null || typeof sub !== "object" || Array.isArray(sub)) {
          throw new UnsupportedPineconeFilterError(`$or member must be a filter object, got ${JSON.stringify(sub)}`);
        }
        const translated = translateFilterNode(sub as Record<string, unknown>);
        if (translated === EMPTY_CONDITION) {
          // An empty $or branch matches everything, which would make the whole $or a no-op —
          // that is a dropped clause in disguise.  Refuse loudly instead.
          throw new UnsupportedPineconeFilterError("$or member translated to an empty filter");
        }
        should.push(translated);
      }
      must.push({ should });
    } else if (key.startsWith("$")) {
      throw new UnsupportedPineconeFilterError(`Unsupported top-level operator "${key}"`);
    } else {
      must.push(translateFieldCondition(key, value));
    }
  }
  if (must.length === 0) return EMPTY_CONDITION;
  return must.length === 1 ? must[0] : { must };
}

/** Marker for "this sub-filter constrains nothing" ({} input) — callers omit it entirely. */
const EMPTY_CONDITION: QdrantCondition = Object.freeze({});

/**
 * Translate a Pinecone metadata filter to a Qdrant condition, or `undefined` when the input is
 * absent/empty (query everything — matches Pinecone's no-filter behavior).  Throws
 * `UnsupportedPineconeFilterError` on anything not implemented.
 */
export function pineconeFilterToQdrant(
  filter: Record<string, unknown> | undefined | null
): QdrantCondition | undefined {
  if (filter == null) return undefined;
  if (typeof filter !== "object" || Array.isArray(filter)) {
    throw new UnsupportedPineconeFilterError(`Filter must be an object, got ${JSON.stringify(filter)}`);
  }
  const translated = translateFilterNode(filter);
  return translated === EMPTY_CONDITION ? undefined : translated;
}

/**
 * The full per-tier Qdrant filter: tenant pin (`ns` == the Pinecone namespace name the tier
 * queries today) AND the translated Pinecone metadata filter.  The `ns` clause is non-optional —
 * it is what keeps one former namespace's data from ever matching another's query.
 */
export function qdrantTenantFilter(
  ns: string,
  filter?: Record<string, unknown>
): QdrantFilter {
  const must: QdrantCondition[] = [{ key: "ns", match: { value: ns } }];
  const translated = pineconeFilterToQdrant(filter);
  if (translated) must.push(translated);
  return { must };
}
