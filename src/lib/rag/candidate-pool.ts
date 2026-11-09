/**
 * persist-candidate-pool (2026-07-06): persist `rankPool`'s OUTPUT candidate pool — every
 * candidate that survived the score floor / as-of guard / hybrid / rerank / dedupe pipeline —
 * split into used (final top-`limit` slice) vs not-used, so "what did we retrieve but not inject"
 * is analyzable after the fact. IMPORTANT (matches the HONESTY NOTE at the capture site in
 * vector-db.ts): this captures the pool AFTER those upstream filters, so candidates DROPPED by
 * minScore / as-of / dedupe are NOT here — only survivors. With the default strategy caller
 * (dedupe 0.6, limit 3) `ordered` is already <= limit, so `used:false` rows are rare/absent there;
 * a v2 capturing the pre-`rankPool` `matches` pool with per-stage drop reasons is the follow-up if
 * "why did we drop this" is the goal. This is a RETRIEVAL selection receipt, not a prompt-use
 * receipt: final model consumption is separately derived after strategy containment and evidence
 * budgeting (`strategy_rag_prompt_consumption`). The pre-slice candidate pool `rankPool` produces
 * is otherwise discarded in-function.
 *
 * Flag-gated via RAG_PERSIST_CANDIDATE_POOL (default OFF, envFlagOn-parsed) — mirrors the
 * RAG_RETRIEVAL_TELEMETRY / recordRetrievalQuality precedent in rag-metering.ts: the flag check
 * happens BEFORE any work (no hashing, no mapping, no audit call) when off, so this is a true
 * no-op, not just a suppressed write, and default retrieval stays byte-for-byte unchanged.
 *
 * Deliberately NOT persisting raw chunk text (only ids/scores/asOf/docType/used) — the same
 * "never persist raw query text" posture `hashQuery` already established for
 * `recordRetrievalQuality`. A consumer that needs the text can join by id against the vector
 * store or the already-persisted attribution rows.
 */

import { audit } from "../db";
import { envFlagOn } from "./env-flag";

/** Returns true when RAG_PERSIST_CANDIDATE_POOL is truthy. Default OFF. */
export function candidatePoolPersistEnabled(): boolean {
  return envFlagOn("RAG_PERSIST_CANDIDATE_POOL", false);
}

export interface CandidatePoolEntry {
  id: string;
  /** Pinecone cosine similarity score. */
  score?: number;
  /** Voyage cross-encoder relevance score (`match._rerankScore`), when reranking ran. */
  relevanceScore?: number;
  /** metadata.doc_type, when present. */
  docType?: string;
  /** Resolved as-of/date stamp from metadata (acceptance_datetime / as_of / timestamp), when present. */
  asOf?: string;
  /** Whether this candidate survived into the final top-`limit` slice returned to the caller. */
  used: boolean;
}

export interface CandidatePoolRecord {
  /** Current strategy run id, when the caller has one (e.g. strategy.ts's per-run retrieval passes). */
  runId?: string;
  symbol: string;
  /** SHA-256 (first 16 hex) of the query — NEVER the raw query text (see hashQuery in rag-metering.ts). */
  queryHash: string;
  /** Point-in-time guard passed to this retrieval call, if any. */
  asOf?: string;
  candidates: CandidatePoolEntry[];
}

/**
 * Persist one candidate-pool record (fire-and-forget, never throws). No-ops entirely when
 * RAG_PERSIST_CANDIDATE_POOL is unset/off — callers are expected to gate the (cheap but
 * non-zero) mapping work at the call site too, but this function double-checks the flag so
 * calling it directly is always safe.
 */
export function recordCandidatePool(record: CandidatePoolRecord, userId: string = "local"): void {
  if (!candidatePoolPersistEnabled()) return;
  try {
    audit(
      "rag_candidate_pool",
      {
        runId: record.runId,
        symbol: record.symbol,
        queryHash: record.queryHash,
        asOf: record.asOf,
        candidateCount: record.candidates.length,
        candidates: record.candidates
      },
      userId
    );
  } catch {
    /* best-effort persistence only; never break retrieval */
  }
}

/**
 * persist-pool-v2 (2026-07-06): the v1 feature above honestly captures only `rankPool`'s OUTPUT
 * pool (`ordered`) — every candidate DROPPED upstream (minScore / as-of / dedupe / rerank) is
 * invisible, so "why did we drop this candidate" could not be answered. v2 closes that gap by
 * capturing the PRE-`rankPool` `matches` pool (the raw Pinecone recall, or the #822 fused pool
 * when multi-query fan-out ran) together with a per-candidate DISPOSITION naming the exact stage
 * that dropped it (see `CandidateDisposition`). The disposition map is produced by `rankPool`
 * itself via its optional `onDispositions` hook (see vector-db.ts) — this module only defines the
 * record shape and the flag/persist function, mirroring v1's split.
 *
 * Flag-gated via RAG_PERSIST_CANDIDATE_POOL_FULL (default OFF, envFlagOn-parsed), DISTINCT from
 * v1's RAG_PERSIST_CANDIDATE_POOL so the two can be toggled independently (v1 stays the cheaper
 * "just the survivors" capture; v2 is the heavier "every candidate + why" capture). The flag check
 * happens BEFORE any work, exactly like v1 — default OFF is a true no-op, not a suppressed write.
 *
 * Same "never persist raw text" posture as v1: candidates carry id/score/relevanceScore/docType/
 * asOf/disposition only.
 */

/** Returns true when RAG_PERSIST_CANDIDATE_POOL_FULL is truthy. Default OFF. */
export function candidatePoolFullPersistEnabled(): boolean {
  return envFlagOn("RAG_PERSIST_CANDIDATE_POOL_FULL", false);
}

/**
 * Per-candidate outcome through the `rankPool` pipeline, in the order stages actually run:
 * minScore floor -> as-of guard -> hybrid fuse (reorder only, never drops) -> cross-encoder
 * rerank (may truncate to `limit` via Voyage's `topK`) -> post-rerank relevance floor -> dedupe ->
 * final top-`limit` slice (applied by the caller, not `rankPool` itself).
 *
 * `dropped_dedupe` vs `dropped_dedupe_truncate` (review fix, 2026-07-06): `dedupeSimilar` itself
 * drops candidates for two DIFFERENT reasons that both look like "absent from its output" if you
 * only diff the before/after pool — a genuine near-duplicate judgment (Jaccard similarity >=
 * threshold against an already-kept chunk), and its OWN internal `kept.length >= limit` cap, which
 * truncates the pool exactly like the final top-`limit` slice does, just one stage earlier. On the
 * flagship production config (strategy.ts: `limit=3`, `dedupeSimilarity=0.6`) the cap fires on
 * almost every run, so lumping both into `dropped_dedupe` mislabeled ordinary truncation as
 * "removed as a near-duplicate" for the common case. `dropped_dedupe` is now reserved for
 * candidates `dedupeSimilar` actually judged too similar to a kept chunk; `dropped_dedupe_truncate`
 * is for distinct candidates it never even got to compare, because its internal cap was already
 * full — see `dedupeSimilar`'s optional `report` out-param in `rag/dedupe-similar.ts`.
 */
export type CandidateDisposition =
  | "dropped_minscore"
  | "dropped_asof"
  | "dropped_rerank_truncate"
  | "dropped_rerank_floor"
  | "dropped_dedupe"
  | "dropped_dedupe_truncate"
  | "kept_not_used"
  | "used";

export interface CandidatePoolEntryV2 {
  id: string;
  /** Pinecone cosine similarity score. */
  score?: number;
  /** Voyage cross-encoder relevance score (`match._rerankScore`), when reranking ran. */
  relevanceScore?: number;
  /** metadata.doc_type, when present. */
  docType?: string;
  /** Resolved as-of/date stamp from metadata (acceptance_datetime / as_of / timestamp), when present. */
  asOf?: string;
  /** The stage that dropped this candidate, or `used`/`kept_not_used` for survivors. */
  disposition: CandidateDisposition;
}

export interface CandidatePoolRecordV2 {
  /** Current strategy run id, when the caller has one (e.g. strategy.ts's per-run retrieval passes). */
  runId?: string;
  symbol: string;
  /** SHA-256 (first 16 hex) of the query — NEVER the raw query text (see hashQuery in rag-metering.ts). */
  queryHash: string;
  /** Point-in-time guard passed to this retrieval call, if any. */
  asOf?: string;
  candidates: CandidatePoolEntryV2[];
}

/**
 * Defensive hard cap (review fix, 2026-07-06) on how many candidates this v2 record ever persists,
 * independent of `matches.length`. `matches` here is bounded by `fetchK`, which for the rerank path
 * is `rerankOverFetchK(limit)` — env-tunable ABOVE its 150 default via VECTOR_RERANK_OVERFETCH_K
 * with no upper clamp in vector-db.ts. An operator setting that env var to a very large value would
 * otherwise let this audit payload balloon 1:1 with it. This cap is intentionally generous (well
 * above any expected `fetchK`) — it exists purely as a backstop against a misconfigured env var,
 * not as a normal operating limit.
 */
const MAX_PERSISTED_CANDIDATES_V2 = 500;

/**
 * Persist one FULL (pre-rankPool + dispositions) candidate-pool record. Fire-and-forget, never
 * throws. No-ops entirely when RAG_PERSIST_CANDIDATE_POOL_FULL is unset/off.
 */
export function recordCandidatePoolFull(record: CandidatePoolRecordV2, userId: string = "local"): void {
  if (!candidatePoolFullPersistEnabled()) return;
  try {
    const candidates = record.candidates.length > MAX_PERSISTED_CANDIDATES_V2
      ? record.candidates.slice(0, MAX_PERSISTED_CANDIDATES_V2)
      : record.candidates;
    audit(
      "rag_candidate_pool_full",
      {
        runId: record.runId,
        symbol: record.symbol,
        queryHash: record.queryHash,
        asOf: record.asOf,
        // `candidateCount` intentionally reflects the TRUE (pre-cap) candidate count, not the
        // possibly-truncated `candidates` array length below — so a capped payload is still
        // honestly labeled as having come from a larger pool, not silently presented as complete.
        candidateCount: record.candidates.length,
        candidates
      },
      userId
    );
  } catch {
    /* best-effort persistence only; never break retrieval */
  }
}
