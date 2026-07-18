// corpus-reembed.ts — re-embed already-ingested local content into the CURRENT active embedding
// space (voyage-finance-2 -> baai/bge-m3, or any future model swap).
//
// Why this exists: embedding-space isolation (PR #1669, vector-db.ts `embeddingSpaceRevisionForModel`
// + `embedSpaceFilterForModel`) means that the instant the active model flips away from Voyage,
// retrieval queries add an `embed_model` metadata filter and every pre-existing Voyage vector
// becomes invisible (by design — cosine scores across embedding spaces are meaningless). That is
// CORRECT isolation, but it also means retrieval goes sparse until the corpus is actually
// re-embedded into the new space. This module is that recovery step — it must run once, after a
// model flip, to backfill the new space from content the app already has locally (no provider
// re-fetch needed).
//
// Re-embeddable FROM LOCAL DB (this module's scope):
//   - SEC 10-K/10-Q chunk text already sitting in `document_chunks_fts` (populated per-chunk by
//     `ingestFiling`, src/lib/web-sources/sec-filings.ts).
//   - EarningsCalls.dev transcripts cached in `earningscalls_transcripts.content`.
//   - Closed-lot trading "experience" documents, reconstructible by replaying `fill_events` through
//     the same FIFO accounting the scorecards use (src/lib/experience-memory.ts).
//   - Insider Form-4 open-market (P/S) transactions in `sec_insider_transactions`, aggregated per
//     (cik, accession, insider) the same way `sec-facts.ts`'s evidence-card formatter does.
// Explicitly OUT of scope (they refresh on their own cadence from their own providers, not from a
// local snapshot — re-embedding them here would just be a slower version of normal ingestion):
// 8-K summaries, FMP transcripts (rights-gated), congress trades, fundamentals cards.
//
// Design constraints (see docs/rollouts/2026-07-18-corpus-reembed.md for the full write-up):
//   - NEVER writes to Pinecone/Voyage directly. Every embed goes through `storeDocument` (SEC
//     filings, EarningsCalls transcripts, insider Form-4 — all three have a fixed, filing-shaped
//     metadata schema that fits `storeDocument`'s `ChunkInput`) or `storeContexts` (experience-memory
//     only — its retrieval-critical metadata (return_pct, risk_exit, per-factor scores, proposal/run
//     ids) has no home in `storeDocument`'s fixed shape, so it keeps using the same primitive its
//     live write-hook already uses). Every ledger receipt, budget fuse
//     (RAG_INGEST_MAX_TEXTS_PER_DAY / RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY), and batch-pacing rule
//     therefore applies automatically, with no bypass.
//   - Idempotent for free: `storeDocument`'s commit id (and vector id) already incorporates the
//     model-aware embedding-space revision (`embeddingSpaceRevisionForModel`, vector-db.ts:146-149)
//     — see `classifyStoreDocumentResult` below for exactly how a same-space rerun short-circuits.
//     `storeContexts` has NO such model-aware id, so the experience-memory path adds the one new
//     guard this module needed: a dedupKeyPrefix namespaced by the active embedding-space revision
//     (see `experienceMemoryDedupPrefix`).
//   - Resumable: a durable per-docType watermark (settings table, via getInternalSetting/
//     setInternalSetting) persists after every processed item, so a restart resumes instead of
//     rescanning. Budget exhaustion stops the WHOLE run cleanly (the daily fuses are shared across
//     every source) without advancing past the item that got deferred.
//   - Serialized under the same durable RAG_REINDEX operation lease `refreshFilingBodies` uses, so
//     this never races scheduled ingest or an operator-triggered 10-K backfill.

import { audit, getInternalSetting, setInternalSetting, getDb } from "../db";
import { normalizeSymbol } from "../money";
import {
  storeDocument,
  storeContexts,
  activeEmbeddingModel,
  embeddingSpaceRevisionForModel,
  purgeManagedVectorsByIds,
  type VectorStoreLeaseGuard,
  type StoreContextsResult
} from "../vector-db";
import type { ChunkInput } from "./chunk";
import {
  OPERATION_LEASE_GROUPS,
  runWithOperationLease,
  startDetachedOperationLease,
  assertOperationLeaseOwnership,
  throwIfOperationLeaseCancelled,
  type OperationLeaseClaim,
  type OperationLeaseBusy,
  type OperationLeaseStartResult
} from "../operation-lease";
import { EARNINGSCALLS_TRANSCRIPT_SOURCE, EARNINGSCALLS_TRANSCRIPT_DOC_TYPE } from "../earningscalls-gate";
import { EARNINGSCALLS_BASE, accessionFor as earningsCallsAccessionFor } from "../earningscalls-transcripts";
import { EXPERIENCE_MEMORY_SOURCE, listClosedLotExperienceDocumentsForAccount } from "../experience-memory";
import { loadCikMap } from "../web-sources/sec8k";
import { padCik } from "../web-sources/sec-filings";
import { listUsers, listConnectedAccounts } from "../db";

// Mirrors vector-db.ts's private `VOYAGE_MODEL` constant (not exported). Comparing against the
// literal is safe: it is a stable, documented model id, not an implementation detail that changes
// silently — see `activeEmbeddingModel`'s doc comment (vector-db.ts:112-125).
const VOYAGE_MODEL = "voyage-finance-2";

const PROGRESS_SETTINGS_KEY = "corpusReembed:progress";
const BATCH_SIZE = 200;

export const CORPUS_REEMBED_DOC_TYPES = [
  "sec-filings",
  "earningscalls-transcripts",
  "experience-memory",
  "insider-form4"
] as const;
export type CorpusReembedDocType = (typeof CORPUS_REEMBED_DOC_TYPES)[number];

/**
 * DocTypes a request with no explicit `docTypes` runs. `insider-form4` is deliberately EXCLUDED
 * from the default set (2026-07-18 adversarial review, MUST-FIX 3): `sec_insider_transactions`
 * has no filed-at column, so the re-embedded documents' point-in-time stamp is a documented
 * approximation (transaction date + 2 business days — see `reembedInsiderForm4`), and the live
 * insider path (`disclosure-rag.ts`, flag-gated `RAG_EMBED_DISCLOSURES`, default OFF) writes a
 * differently-shaped/identified document via `storeContexts`, so running both would coexist as
 * near-duplicates. Run it by explicitly listing `docTypes: ["insider-form4"]` once those
 * trade-offs are acceptable for the operator's use.
 */
export const DEFAULT_CORPUS_REEMBED_DOC_TYPES: CorpusReembedDocType[] = [
  "sec-filings",
  "earningscalls-transcripts",
  "experience-memory"
];

function isCorpusReembedDocType(value: unknown): value is CorpusReembedDocType {
  return typeof value === "string" && (CORPUS_REEMBED_DOC_TYPES as readonly string[]).includes(value);
}

/** Local-receipt source tag each docType's vectors are stamped with (`vector_ingest_commits.source`
 *  / `chunk_occurrences.source`). `experience-memory` has none — it never goes through
 *  `storeDocument`'s managed-commit ledger (see module doc comment), so it's intentionally absent
 *  from this map and always excluded from the legacy-purge scan. */
const DOC_TYPE_SOURCE_TAG: Partial<Record<CorpusReembedDocType, string>> = {
  "sec-filings": "sec-edgar",
  "earningscalls-transcripts": EARNINGSCALLS_TRANSCRIPT_SOURCE,
  "insider-form4": "insider-filing"
};

// ── Progress / watermark persistence ────────────────────────────────────────────

type ReembedOutcomeStatus = "idle" | "running" | "completed" | "stopped-budget" | "stopped-cap" | "error";

export interface CorpusReembedDocTypeProgress {
  status: ReembedOutcomeStatus;
  /** Opaque, docType-specific resumable cursor. `null` = start from the beginning. */
  watermark: unknown;
  /**
   * The embedding-space revision the watermark (and the cumulative counts below) belong to.
   * A watermark is only meaningful for the scan that produced it; resuming a stale one after a
   * model flip would skip the entire corpus and instantly report "completed" with zero embeds —
   * which is exactly the state the legacy purge gate must never trust (2026-07-18 adversarial
   * review, MUST-FIX 1b). Loading code DISCARDS the watermark and counts when this doesn't match
   * the current revision.
   */
  watermarkEmbedRevision?: string;
  /** Counts are CUMULATIVE across resumed runs since the current watermark chain started (i.e.
   *  since the last fresh scan under `watermarkEmbedRevision`), so partial-run failures are never
   *  forgotten by a later resume (MUST-FIX 1c). */
  candidatesSeen: number;
  embedded: number;
  reusedInSpace: number;
  failed: number;
  /** The embedding-space revision this docType last reached "completed" under, stamped ONLY by a
   *  full-corpus (non-symbol-scoped) scan. `purgeLegacy...` refuses unless this equals the
   *  CURRENT revision — and cumulative `failed` is zero — for every covered docType. */
  completedForEmbedRevision?: string;
  lastRunAt: string;
}

export interface CorpusReembedProgressState {
  updatedAt: string;
  status: ReembedOutcomeStatus;
  embedModel: string;
  embedRevision: string;
  dryRun: boolean;
  docTypes: Partial<Record<CorpusReembedDocType, CorpusReembedDocTypeProgress>>;
  error?: string;
}

function readProgress(): CorpusReembedProgressState | undefined {
  return getInternalSetting<CorpusReembedProgressState>(PROGRESS_SETTINGS_KEY);
}

function writeProgress(state: CorpusReembedProgressState): void {
  setInternalSetting(PROGRESS_SETTINGS_KEY, state);
}

/** Admin GET surface: the persisted snapshot plus the live active-model reading (so the operator
 *  can tell which space is currently being filled even before any run has ever happened). */
export function getCorpusReembedProgress(userId: string = "local"): {
  persisted: CorpusReembedProgressState | undefined;
  activeEmbedModel: string;
  activeEmbedRevision: string;
} {
  const activeEmbedModel = activeEmbeddingModel(userId);
  return {
    persisted: readProgress(),
    activeEmbedModel,
    activeEmbedRevision: embeddingSpaceRevisionForModel(activeEmbedModel)
  };
}

/** Test-only reset so isolated temp-DB suites don't leak state across tests. */
export function resetCorpusReembedStateForTest(): void {
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(PROGRESS_SETTINGS_KEY);
}

// ── Shared result classification ────────────────────────────────────────────────

type CandidateOutcome = "embedded" | "reused" | "failed" | "budget-exhausted";

function isBudgetExhausted(result: StoreContextsResult): boolean {
  return (result.budgetSkipped ?? 0) > 0 || (result.writeUnitBudgetSkipped ?? 0) > 0 || result.unconfigured === true;
}

/** Mirrors `ingestFiling`/`ingestCachedTranscript`'s exact completeness contract: `documentComplete`
 *  plus either exact `indexed === attempted` cardinality or an exact `reusedCommitted` receipt.
 *  `reusedCommitted` (indexed 0, documentComplete true) is the FREE same-space-rerun skip that makes
 *  this module idempotent — it fires when `storeDocument`'s commit id (which incorporates the active
 *  embedding-space revision) already matches a fully committed local receipt, so nothing is
 *  re-embedded or re-upserted; see `committedVectorCommitDisposition` (vector-db.ts:3031-3110), used
 *  at the top of `storeDocumentImpl`'s `withSerializedVectorCommit` block (vector-db.ts:3368-3399)
 *  BEFORE any provider call. A model flip changes the commit id (embedRev differs), so this same
 *  check naturally falls through to a real embed in the new space instead of reusing the old one. */
function classifyStoreDocumentResult(result: StoreContextsResult): CandidateOutcome {
  if (isBudgetExhausted(result)) return "budget-exhausted";
  const reused = result.reusedCommitted === true && result.documentComplete === true && result.attempted > 0;
  if (reused) return "reused";
  const complete = !result.error && result.documentComplete === true && result.indexed === result.attempted;
  return complete ? "embedded" : "failed";
}

/** `storeContexts` (experience-memory only) has no commit-id/embedRev-aware dedup of its own —
 *  `contextId` (vector-db.ts:1853-1860) derives the Pinecone id from source/symbol/accession/
 *  timestamp alone, and `document_chunks` content-hash dedup (the `dedupKeyPrefix` option) is
 *  likewise model-agnostic. `experienceMemoryDedupPrefix` below is the "minimal guard" that makes a
 *  same-space rerun free anyway: it folds the active embedding-space revision INTO the dedup prefix
 *  string, so a prior run's dedup rows only ever satisfy a rerun under the SAME active model. A
 *  model flip changes the prefix, so the next run's dedupKeyPrefix lookup naturally misses and
 *  re-embeds — same free-vs-fresh behavior as storeDocument's commit id, achieved without touching
 *  vector-db.ts's dedup internals. Because the write is a plain upsert keyed by the SAME (stable,
 *  non-model-aware) Pinecone id, re-embedding a closed-lot doc OVERWRITES the prior vector in place
 *  — there is no separate legacy vector left behind, so experience-memory is intentionally excluded
 *  from the legacy-purge scan (see DOC_TYPE_SOURCE_TAG). */
function classifyStoreContextsResult(result: StoreContextsResult): CandidateOutcome {
  if (isBudgetExhausted(result)) return "budget-exhausted";
  if (result.error) return "failed";
  if (result.dedupComplete === true) return "reused";
  if (result.attempted === 0) return "reused";
  if (result.indexed === result.attempted) return "embedded";
  return "failed";
}

// ── Per-docType tallies ─────────────────────────────────────────────────────────

interface DocTypeRunState {
  docType: CorpusReembedDocType;
  candidatesSeen: number;
  embedded: number;
  reusedInSpace: number;
  failed: number;
  stoppedForBudget: boolean;
  stoppedForCap: boolean;
  completed: boolean;
  watermark: unknown;
}

function freshDocTypeRunState(docType: CorpusReembedDocType, initialWatermark: unknown): DocTypeRunState {
  return {
    docType,
    candidatesSeen: 0,
    embedded: 0,
    reusedInSpace: 0,
    failed: 0,
    stoppedForBudget: false,
    stoppedForCap: false,
    completed: false,
    watermark: initialWatermark ?? null
  };
}

function applyOutcome(state: DocTypeRunState, outcome: CandidateOutcome): void {
  state.candidatesSeen += 1;
  if (outcome === "embedded") state.embedded += 1;
  else if (outcome === "reused") state.reusedInSpace += 1;
  else if (outcome === "failed") state.failed += 1;
}

// ── Budget-shared invocation cap ─────────────────────────────────────────────────

class MaxTextsReachedError extends Error {
  constructor() {
    super("corpus-reembed maxTexts cap reached for this invocation");
    this.name = "MaxTextsReachedError";
  }
}

class BudgetExhaustedStop extends Error {
  constructor() {
    super("corpus-reembed stopped: RAG ingest/write-unit budget exhausted");
    this.name = "BudgetExhaustedStop";
  }
}

/** Thrown when the ACTIVE embedding model changes underneath a running re-embed (e.g. an operator
 *  adds/removes the openrouter/siliconflow key mid-run). Everything embedded so far went to the
 *  space captured at run start; continuing would silently split the run across two spaces, so the
 *  whole run aborts with status "error" instead (MUST-FIX 1e). */
class ModelDriftAbort extends Error {
  constructor(expected: string, actual: string) {
    super(`corpus-reembed aborted: active embedding model changed mid-run (started under "${expected}", now "${actual}")`);
    this.name = "ModelDriftAbort";
  }
}

// ── docType: sec-filings ─────────────────────────────────────────────────────────

interface SecFilingsWatermark {
  rowid: number;
}

interface SecFilingCandidateRow {
  rowid: number;
  content_hash: string;
  symbol: string;
  accession: string;
  text: string;
  form: string | null;
  filed_at: string | null;
  accepted_at: string | null;
}

function listSecFilingCandidates(afterRowid: number, symbols: string[] | undefined, limit: number): SecFilingCandidateRow[] {
  const db = getDb();
  const symbolClause = symbols && symbols.length > 0 ? `AND f.symbol IN (${symbols.map(() => "?").join(",")})` : "";
  const params: (string | number)[] = [afterRowid];
  if (symbols && symbols.length > 0) params.push(...symbols);
  params.push(limit);
  return db.prepare(`
    SELECT f.rowid AS rowid, f.content_hash AS content_hash, f.symbol AS symbol, f.accession AS accession,
           f.text AS text, s.form AS form, s.filed_at AS filed_at, s.accepted_at AS accepted_at
    FROM document_chunks_fts f
    LEFT JOIN sec_filings s ON s.accession = f.accession
    WHERE f.source = 'sec-edgar' AND f.rowid > ? ${symbolClause}
    ORDER BY f.rowid ASC
    LIMIT ?
  `).all(...params) as SecFilingCandidateRow[];
}

/**
 * True when the LIVE sec-filings ingestion path (`ingestFiling`, sec-filings.ts) has already
 * committed this accession into the CURRENT embedding space. The live path's whole-document
 * identity — doc_id `${ticker}:${accession}:${docType}` with the full section-derived body and
 * url — CANNOT be reconstructed from FTS chunk rows, so the backfill cannot dedup onto the same
 * commit; instead it must SKIP accessions the live path already covered (2026-07-18 adversarial
 * review, MUST-FIX 2: without this, post-flip filings ingested live AND backfilled here would
 * exist twice in the corpus under two identities). `vector_ingest_commits.accession` stores the
 * live path's doc_id verbatim.
 */
function liveSecFilingCommittedInCurrentSpace(
  symbol: string,
  accession: string,
  form: string | null,
  embedRevision: string
): boolean {
  const liveDocId = `${symbol}:${accession}:${form ?? "10-K"}`;
  const row = getDb().prepare(`
    SELECT 1 FROM vector_ingest_commits
    WHERE source = 'sec-edgar' AND accession = ? AND embed_revision = ? AND state = 'committed'
    LIMIT 1
  `).get(liveDocId, embedRevision);
  return Boolean(row);
}

async function reembedSecFilings(ctx: RunContext, state: DocTypeRunState): Promise<void> {
  let afterRowid = ((state.watermark as SecFilingsWatermark | null)?.rowid) ?? 0;
  // Per-run memo of accessions the live path already committed in the current space — one SQL
  // probe per accession instead of one per chunk row.
  const liveCoveredByAccession = new Map<string, boolean>();
  for (;;) {
    ctx.throwIfCancelled();
    const rows = listSecFilingCandidates(afterRowid, ctx.symbols, BATCH_SIZE);
    if (rows.length === 0) {
      state.completed = true;
      return;
    }
    for (const row of rows) {
      ctx.throwIfCancelled();
      ctx.consumeMaxTexts();
      const documentKey = `${row.accession}:${row.content_hash}`;
      const docType = (row.form || "10-k").toLowerCase();
      const publishedAt = row.filed_at ?? row.accepted_at ?? new Date().toISOString();
      const acceptanceDatetime = row.accepted_at ?? row.filed_at ?? publishedAt;
      let liveCovered = liveCoveredByAccession.get(row.accession);
      if (liveCovered === undefined) {
        liveCovered = liveSecFilingCommittedInCurrentSpace(row.symbol, row.accession, row.form, ctx.embedRevision);
        liveCoveredByAccession.set(row.accession, liveCovered);
      }
      if (liveCovered) {
        // The live whole-document ingestion already put this filing into the current space —
        // its chunks are retrievable there under the live identity. Backfilling the FTS chunk
        // would create a second, differently-identified copy. Count as in-space reuse.
        applyOutcome(state, "reused");
      } else if (ctx.dryRun) {
        applyOutcome(state, classifyDryRun(ctx, "sec-edgar", documentKey));
      } else {
        const doc: ChunkInput & { symbol?: string } = {
          text: row.text,
          doc_id: documentKey,
          ticker: row.symbol,
          title: `${row.symbol} ${row.form ?? "10-K"} (${publishedAt})`,
          doc_type: docType,
          published_at: publishedAt,
          acceptance_datetime: acceptanceDatetime,
          source: "sec-edgar"
        };
        const result = await storeDocument(doc, ctx.userId, {
          // Same parser revision string as the live sec-filings.ts ingestion path — but NOTE:
          // this backfill's per-chunk identity (doc_id/documentKey `${accession}:${content_hash}`,
          // no url/sections) is deliberately DISTINCT from the live path's whole-document
          // identity, so the two never dedup onto the same commit. Coexistence is prevented by
          // the live-identity skip above, not by commit-id collision (MUST-FIX 2 correction of
          // an earlier, wrong comment here).
          parserRevision: "sec-edgar-filing-v2",
          documentKey,
          leaseGuard: ctx.leaseGuard
        });
        const outcome = classifyStoreDocumentResult(result);
        applyOutcome(state, outcome);
        if (outcome === "budget-exhausted") {
          state.stoppedForBudget = true;
          throw new BudgetExhaustedStop();
        }
      }
      afterRowid = row.rowid;
      state.watermark = { rowid: afterRowid } satisfies SecFilingsWatermark;
      ctx.persistDocTypeProgress(state);
    }
    if (rows.length < BATCH_SIZE) {
      state.completed = true;
      return;
    }
  }
}

// ── docType: earningscalls-transcripts ──────────────────────────────────────────

interface EarningsCallsWatermark {
  symbol: string;
  fiscalYear: number;
  fiscalQuarter: number;
}

interface EarningsCallsCandidateRow {
  symbol: string;
  fiscal_year: number;
  fiscal_quarter: number;
  event_id: number | null;
  event_date: string | null;
  content: string;
  fetched_at: string;
}

function listEarningsCallsCandidates(
  after: EarningsCallsWatermark | null,
  symbols: string[] | undefined,
  limit: number
): EarningsCallsCandidateRow[] {
  const db = getDb();
  const symbolClause = symbols && symbols.length > 0 ? `AND symbol IN (${symbols.map(() => "?").join(",")})` : "";
  const watermarkClause = after ? "AND (symbol, fiscal_year, fiscal_quarter) > (?, ?, ?)" : "";
  const params: (string | number)[] = [];
  if (after) params.push(after.symbol, after.fiscalYear, after.fiscalQuarter);
  if (symbols && symbols.length > 0) params.push(...symbols);
  params.push(limit);
  return db.prepare(`
    SELECT symbol, fiscal_year, fiscal_quarter, event_id, event_date, content, fetched_at
    FROM earningscalls_transcripts
    WHERE content IS NOT NULL ${watermarkClause} ${symbolClause}
    ORDER BY symbol, fiscal_year, fiscal_quarter
    LIMIT ?
  `).all(...params) as EarningsCallsCandidateRow[];
}

async function reembedEarningsCallsTranscripts(ctx: RunContext, state: DocTypeRunState): Promise<void> {
  let after = (state.watermark as EarningsCallsWatermark | null) ?? null;
  for (;;) {
    ctx.throwIfCancelled();
    const rows = listEarningsCallsCandidates(after, ctx.symbols, BATCH_SIZE);
    if (rows.length === 0) {
      state.completed = true;
      return;
    }
    for (const row of rows) {
      ctx.throwIfCancelled();
      ctx.consumeMaxTexts();
      const accession = earningsCallsAccessionFor({
        symbol: row.symbol,
        fiscalYear: row.fiscal_year,
        fiscalQuarter: row.fiscal_quarter
      });
      if (ctx.dryRun) {
        applyOutcome(state, classifyDryRun(ctx, EARNINGSCALLS_TRANSCRIPT_SOURCE, accession));
      } else {
        const doc: ChunkInput & { symbol?: string } = {
          text: row.content,
          doc_id: accession,
          ticker: row.symbol,
          title: `${row.symbol} earnings call ${row.fiscal_year} Q${row.fiscal_quarter}`,
          doc_type: EARNINGSCALLS_TRANSCRIPT_DOC_TYPE,
          published_at: row.event_date ?? row.fetched_at,
          acceptance_datetime: row.fetched_at,
          source: EARNINGSCALLS_TRANSCRIPT_SOURCE,
          // MUST-FIX 2: byte-identical to the live `ingestCachedTranscript` document
          // (earningscalls-transcripts.ts ~line 526) INCLUDING the url — the url feeds
          // retrievalMetadataVersion, which feeds the commit id, so matching it makes this
          // backfill's identity EXACTLY the live path's. A transcript ingested by either path
          // dedups onto the same commit in the same space; no double-embedding is possible.
          url: row.event_id
            ? `${EARNINGSCALLS_BASE}/transcripts/${row.event_id}`
            : `${EARNINGSCALLS_BASE}/search/by_ticker`
        };
        const result = await storeDocument(doc, ctx.userId, {
          // Same parser revision the live earningscalls-transcripts.ts push uses (line ~529).
          parserRevision: "earningscalls-transcript-v1",
          documentKey: accession,
          leaseGuard: ctx.leaseGuard
        });
        const outcome = classifyStoreDocumentResult(result);
        applyOutcome(state, outcome);
        if (outcome === "budget-exhausted") {
          state.stoppedForBudget = true;
          throw new BudgetExhaustedStop();
        }
      }
      after = { symbol: row.symbol, fiscalYear: row.fiscal_year, fiscalQuarter: row.fiscal_quarter };
      state.watermark = after satisfies EarningsCallsWatermark;
      ctx.persistDocTypeProgress(state);
    }
    if (rows.length < BATCH_SIZE) {
      state.completed = true;
      return;
    }
  }
}

// ── docType: insider-form4 ───────────────────────────────────────────────────────

interface InsiderForm4Watermark {
  accession: string;
  cik: string;
  insiderName: string;
}

interface InsiderForm4CandidateRow {
  cik: string;
  accession: string;
  insider_name: string;
  buy_shares: number;
  buy_tx: number;
  sell_shares: number;
  sell_tx: number;
  period_of_report: string;
}

function listInsiderForm4Candidates(
  after: InsiderForm4Watermark | null,
  ciks: string[] | undefined,
  limit: number
): InsiderForm4CandidateRow[] {
  const db = getDb();
  const cikClause = ciks && ciks.length > 0 ? `AND t.cik IN (${ciks.map(() => "?").join(",")})` : "";
  const watermarkClause = after ? "WHERE (t.accession, t.cik, t.insider_name) > (?, ?, ?)" : "";
  const params: (string | number)[] = [];
  if (after) params.push(after.accession, after.cik, after.insiderName);
  if (ciks && ciks.length > 0) params.push(...ciks);
  params.push(limit);
  return db.prepare(`
    SELECT * FROM (
      SELECT cik, accession, insider_name,
        SUM(CASE WHEN side = 'buy' THEN shares ELSE 0 END) AS buy_shares,
        SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END) AS buy_tx,
        SUM(CASE WHEN side = 'sell' THEN shares ELSE 0 END) AS sell_shares,
        SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END) AS sell_tx,
        MAX(period_of_report) AS period_of_report
      FROM sec_insider_transactions t
      WHERE transaction_code IN ('P', 'S') ${cikClause}
      GROUP BY cik, accession, insider_name
    ) t
    ${watermarkClause}
    ORDER BY t.accession, t.cik, t.insider_name
    LIMIT ?
  `).all(...params) as InsiderForm4CandidateRow[];
}

/** Narrative template intentionally mirrors `disclosure-rag.ts`'s `filingToDoc` (lines 70-88) so a
 *  re-embedded insider doc reads identically to one produced by the live (different-dataset)
 *  ingestion path; that function isn't exported (it operates over a different InsiderFiling shape
 *  sourced from the polled "current Form 4" feed, not this `sec_insider_transactions` aggregation),
 *  so the template is intentionally duplicated here rather than imported. */
function insiderForm4Text(input: {
  symbol: string;
  owner: string;
  buyTx: number;
  buyShares: number;
  sellTx: number;
  sellShares: number;
  filedAt: string;
  accession: string;
}): string {
  return (
    `Insider filing for ${input.symbol} by ${input.owner}. ` +
    `Open-market purchases: ${input.buyTx} transaction(s) (${input.buyShares} shares). ` +
    `Open-market sales: ${input.sellTx} transaction(s) (${input.sellShares} shares). ` +
    `Filed: ${input.filedAt}. Accession: ${input.accession}.`
  );
}

/**
 * Conservative point-in-time floor for insider Form-4 documents (2026-07-18 adversarial review,
 * MUST-FIX 3): `sec_insider_transactions` stores only `period_of_report` — the TRANSACTION date —
 * and Form 4s are legally filed up to two business days AFTER the transaction (SEC §16 deadline).
 * Stamping the transaction date as availability would make backfilled vectors retrievable in
 * backtests BEFORE the public could have seen the filing (look-ahead bias). Stamping transaction
 * date + 2 business days pushes the availability estimate to the far end of the legal window:
 * for any filing made before its deadline (the overwhelmingly common case), the vector becomes
 * retrievable LATER than reality — the safe direction for point-in-time correctness. Weekend-aware
 * but ignores market holidays; a deadline that crossed a holiday could make the TRUE filing time
 * later than this stamp — that narrow residual window is accepted and documented in the rollout
 * note, and is one of the reasons insider-form4 is excluded from DEFAULT_CORPUS_REEMBED_DOC_TYPES.
 */
export function insiderForm4AvailabilityFloor(periodOfReport: string): string {
  const parsed = Date.parse(periodOfReport);
  if (!Number.isFinite(parsed)) return periodOfReport;
  const date = new Date(parsed);
  let added = 0;
  while (added < 2) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return date.toISOString();
}

async function reembedInsiderForm4(ctx: RunContext, state: DocTypeRunState): Promise<void> {
  // cik -> ticker: loadCikMap keys by bare numeric CIK strings; sec_insider_transactions.cik is
  // zero-padded (parseAndSaveForm4 stores `padCik(cik)`). Re-pad the map's keys to match.
  const cikMap = await loadCikMap(Date.now());
  const paddedCikToTicker: Record<string, string> = {};
  for (const [cik, ticker] of Object.entries(cikMap)) paddedCikToTicker[padCik(cik)] = ticker;
  const ciks = ctx.symbols
    ? Object.entries(paddedCikToTicker)
        .filter(([, ticker]) => ctx.symbols!.includes(ticker))
        .map(([cik]) => cik)
    : undefined;
  // An explicit symbol filter that resolves to zero known CIKs means there is nothing to do —
  // distinct from "no filter" (undefined), which must not be turned into an empty IN() clause.
  if (ctx.symbols && (!ciks || ciks.length === 0)) {
    state.completed = true;
    return;
  }

  let after = (state.watermark as InsiderForm4Watermark | null) ?? null;
  for (;;) {
    ctx.throwIfCancelled();
    const rows = listInsiderForm4Candidates(after, ciks, BATCH_SIZE);
    if (rows.length === 0) {
      state.completed = true;
      return;
    }
    for (const row of rows) {
      ctx.throwIfCancelled();
      const symbol = paddedCikToTicker[row.cik];
      // A CIK not in the current company_tickers.json snapshot (delisted/renamed) can't be
      // resolved to a symbol; skip it rather than embed an unattributed document. Does not advance
      // past it as "failed" — it's out-of-scope data, not a store error.
      if (!symbol) {
        after = { accession: row.accession, cik: row.cik, insiderName: row.insider_name };
        state.watermark = after satisfies InsiderForm4Watermark;
        ctx.persistDocTypeProgress(state);
        continue;
      }
      ctx.consumeMaxTexts();
      const documentKey = `insider-form4:${row.accession}:${row.cik}:${row.insider_name}`;
      if (ctx.dryRun) {
        applyOutcome(state, classifyDryRun(ctx, "insider-filing", documentKey));
      } else {
        // MUST-FIX 3: availability is stamped at period_of_report + 2 business days — the
        // conservative far end of the Form-4 filing window — never the transaction date itself.
        const availabilityFloor = insiderForm4AvailabilityFloor(row.period_of_report);
        const text = insiderForm4Text({
          symbol,
          owner: row.insider_name,
          buyTx: row.buy_tx,
          buyShares: row.buy_shares,
          sellTx: row.sell_tx,
          sellShares: row.sell_shares,
          // The table has no filed-at column; the text shows the estimated availability floor,
          // explicitly labeled as such via the availability-floor helper's contract.
          filedAt: availabilityFloor,
          accession: row.accession
        });
        const doc: ChunkInput & { symbol?: string } = {
          text,
          doc_id: documentKey,
          ticker: symbol,
          title: `${symbol} insider filing (${row.accession})`,
          doc_type: "insider-filing",
          published_at: availabilityFloor,
          acceptance_datetime: availabilityFloor,
          source: "insider-filing"
        };
        const result = await storeDocument(doc, ctx.userId, {
          parserRevision: "insider-form4-reembed-v1",
          documentKey,
          leaseGuard: ctx.leaseGuard
        });
        const outcome = classifyStoreDocumentResult(result);
        applyOutcome(state, outcome);
        if (outcome === "budget-exhausted") {
          state.stoppedForBudget = true;
          throw new BudgetExhaustedStop();
        }
      }
      after = { accession: row.accession, cik: row.cik, insiderName: row.insider_name };
      state.watermark = after satisfies InsiderForm4Watermark;
      ctx.persistDocTypeProgress(state);
    }
    if (rows.length < BATCH_SIZE) {
      state.completed = true;
      return;
    }
  }
}

// ── docType: experience-memory ──────────────────────────────────────────────────

interface ExperienceMemoryWatermark {
  userId: string;
  accountNumber: string;
}

function experienceMemoryDedupPrefix(embedRevision: string): string {
  return `${EXPERIENCE_MEMORY_SOURCE}:reembed:${embedRevision}`;
}

function listAccountCandidates(symbols: string[] | undefined): Array<{ userId: string; accountNumber: string; environment: "paper" | "live"; connectedAccountId?: string }> {
  const users = listUsers();
  const accounts: Array<{ userId: string; accountNumber: string; environment: "paper" | "live"; connectedAccountId?: string }> = [];
  for (const userId of users) {
    for (const account of listConnectedAccounts(userId)) {
      if (!account.accountNumber) continue;
      accounts.push({
        userId,
        accountNumber: account.accountNumber,
        environment: account.environment,
        connectedAccountId: account.id
      });
    }
  }
  // Experience-memory documents aren't per-symbol content — the `symbols` filter doesn't apply at
  // the account level (a symbol filter would require inspecting every account's closed lots, which
  // defeats the point of an account-granularity watermark). Accepted trade-off, documented in the
  // rollout note: `symbols` scopes sec-filings/earningscalls/insider-form4 only.
  void symbols;
  return accounts.sort((a, b) => (a.userId === b.userId ? a.accountNumber.localeCompare(b.accountNumber) : a.userId.localeCompare(b.userId)));
}

async function reembedExperienceMemory(ctx: RunContext, state: DocTypeRunState): Promise<void> {
  const accounts = listAccountCandidates(ctx.symbols);
  const after = state.watermark as ExperienceMemoryWatermark | null;
  let resumeIndex = 0;
  if (after) {
    const idx = accounts.findIndex((a) => a.userId === after.userId && a.accountNumber === after.accountNumber);
    resumeIndex = idx >= 0 ? idx + 1 : 0;
  }
  if (resumeIndex >= accounts.length) {
    state.completed = true;
    return;
  }

  const dedupKeyPrefix = experienceMemoryDedupPrefix(ctx.embedRevision);
  for (let i = resumeIndex; i < accounts.length; i++) {
    ctx.throwIfCancelled();
    const account = accounts[i]!;
    if (ctx.dryRun) {
      const documents = await listClosedLotExperienceDocumentsForAccount({
        userId: account.userId,
        connectedAccountId: account.connectedAccountId,
        accountEnvironment: account.environment,
        accountNumber: account.accountNumber
      });
      for (let d = 0; d < documents.length; d++) {
        ctx.consumeMaxTexts();
        state.candidatesSeen += 1;
        state.embedded += 1; // dry run: no cheap per-doc "already reused" signal for storeContexts writes (see module doc comment) — reported as "would embed".
      }
    } else {
      const documents = await listClosedLotExperienceDocumentsForAccount({
        userId: account.userId,
        connectedAccountId: account.connectedAccountId,
        accountEnvironment: account.environment,
        accountNumber: account.accountNumber
      });
      if (documents.length > 0) {
        ctx.consumeMaxTexts(documents.length);
        const result = await storeContexts(documents, account.userId, {
          dedupKeyPrefix,
          scope: "private",
          leaseGuard: ctx.leaseGuard
        });
        const outcome = classifyStoreContextsResult(result);
        state.candidatesSeen += documents.length;
        if (outcome === "embedded") state.embedded += documents.length;
        else if (outcome === "reused") state.reusedInSpace += documents.length;
        else if (outcome === "failed") state.failed += documents.length;
        else {
          state.stoppedForBudget = true;
          state.watermark = i > resumeIndex
            ? ({ userId: accounts[i - 1]!.userId, accountNumber: accounts[i - 1]!.accountNumber } satisfies ExperienceMemoryWatermark)
            : after;
          ctx.persistDocTypeProgress(state);
          throw new BudgetExhaustedStop();
        }
      }
    }
    state.watermark = { userId: account.userId, accountNumber: account.accountNumber } satisfies ExperienceMemoryWatermark;
    ctx.persistDocTypeProgress(state);
  }
  state.completed = true;
}

// ── Dry-run classification (advisory only; the real run always defers to storeDocument's own
//    authoritative commit-id dedup, never to this estimate) ─────────────────────────────────────

function classifyDryRun(ctx: RunContext, sourceTag: string, documentKey: string): CandidateOutcome {
  const row = getDb().prepare(`
    SELECT 1 FROM vector_ingest_commits
    WHERE source = ? AND document_key = ? AND embed_revision = ? AND state = 'committed'
    LIMIT 1
  `).get(sourceTag, documentKey, ctx.embedRevision);
  return row ? "reused" : "embedded";
}

// ── Orchestration ────────────────────────────────────────────────────────────────

export interface RunCorpusReembedOptions {
  docTypes?: CorpusReembedDocType[];
  symbols?: string[];
  /** Bounds total documents PROCESSED across all docTypes in this single invocation. Omitted =
   *  unbounded (drains everything the daily budget fuses allow). */
  maxTexts?: number;
  userId?: string;
}

export interface CorpusReembedDocTypeResult {
  docType: CorpusReembedDocType;
  candidatesSeen: number;
  embedded: number;
  reusedInSpace: number;
  failed: number;
  completed: boolean;
  stoppedForBudget: boolean;
}

export interface CorpusReembedRunResult {
  dryRun: boolean;
  embedModel: string;
  embedRevision: string;
  stoppedForBudget: boolean;
  stoppedForCap: boolean;
  /** Set when the run aborted because the active embedding model changed mid-run. */
  error?: string;
  docTypes: CorpusReembedDocTypeResult[];
}

interface RunContext {
  userId: string;
  symbols?: string[];
  dryRun: boolean;
  embedRevision: string;
  leaseGuard: VectorStoreLeaseGuard;
  throwIfCancelled: () => void;
  consumeMaxTexts: (count?: number) => void;
  persistDocTypeProgress: (state: DocTypeRunState) => void;
}

function normalizedSymbols(symbols?: string[]): string[] | undefined {
  if (!symbols || symbols.length === 0) return undefined;
  const set = new Set(symbols.map((s) => normalizeSymbol(s)).filter(Boolean));
  return set.size > 0 ? [...set] : undefined;
}

function resolveDocTypes(requested: CorpusReembedDocType[] | undefined): CorpusReembedDocType[] {
  if (!requested || requested.length === 0) return [...DEFAULT_CORPUS_REEMBED_DOC_TYPES];
  return [...new Set(requested.filter(isCorpusReembedDocType))];
}

async function runCorpusReembedLocked(
  opts: RunCorpusReembedOptions & { dryRun: boolean },
  claim: OperationLeaseClaim,
  signal: AbortSignal
): Promise<CorpusReembedRunResult> {
  const userId = opts.userId ?? "local";
  const embedModel = activeEmbeddingModel(userId);
  const embedRevision = embeddingSpaceRevisionForModel(embedModel);
  const docTypes = resolveDocTypes(opts.docTypes);
  const symbols = normalizedSymbols(opts.symbols);

  const leaseGuard: VectorStoreLeaseGuard = {
    signal,
    assertOwnership: () => {
      throwIfOperationLeaseCancelled(signal);
      assertOperationLeaseOwnership(claim);
    }
  };

  let remainingMaxTexts = typeof opts.maxTexts === "number" && Number.isFinite(opts.maxTexts) && opts.maxTexts > 0
    ? Math.floor(opts.maxTexts)
    : undefined;
  let stoppedForCap = false;

  // Symbol-scoped runs are STATELESS "targeted top-up" operations: they neither read nor write
  // watermarks or cumulative counts, and they can never stamp completion. A scoped scan only
  // visits the requested symbols' rows, so any watermark it advanced would leave un-requested
  // symbols permanently skipped by a later full scan — and any completion it stamped would let
  // the purge gate believe the whole docType was covered (2026-07-18 adversarial review,
  // MUST-FIX 1a — proven by test/corpus-reembed-adversarial.test.ts). Idempotency for scoped
  // reruns comes from storeDocument's committed-receipt reuse, not from watermarks.
  const scoped = Boolean(symbols && symbols.length > 0);

  const priorProgress = readProgress();
  const results: CorpusReembedDocTypeResult[] = [];
  let stoppedForBudget = false;
  let driftError: string | undefined;

  const persistRunning = (docType: CorpusReembedDocType, docState: DocTypeRunState, base: { candidatesSeen: number; embedded: number; reusedInSpace: number; failed: number }) => {
    // Dry runs and symbol-scoped runs are strictly non-persisting: counts come back in the
    // response, and neither watermarks, cumulative counts, nor completion stamps may advance.
    if (opts.dryRun || scoped) return;
    const now = new Date().toISOString();
    const existing = readProgress();
    const nextDocTypes = { ...(existing?.docTypes ?? {}) };
    const prior = nextDocTypes[docType];
    nextDocTypes[docType] = {
      status: docState.stoppedForBudget ? "stopped-budget" : docState.completed ? "completed" : "running",
      watermark: docState.watermark,
      watermarkEmbedRevision: embedRevision,
      candidatesSeen: base.candidatesSeen + docState.candidatesSeen,
      embedded: base.embedded + docState.embedded,
      reusedInSpace: base.reusedInSpace + docState.reusedInSpace,
      failed: base.failed + docState.failed,
      // Completion is stamped only by a full-corpus scan that reached the end; a stamp from an
      // earlier revision is dropped once the scan runs under a new one (watermark chain restarts).
      ...(docState.completed
        ? { completedForEmbedRevision: embedRevision }
        : prior?.completedForEmbedRevision === embedRevision
          ? { completedForEmbedRevision: prior.completedForEmbedRevision }
          : {}),
      lastRunAt: now
    };
    writeProgress({
      updatedAt: now,
      status: "running",
      embedModel,
      embedRevision,
      dryRun: false,
      docTypes: nextDocTypes
    });
  };

  for (const docType of docTypes) {
    throwIfOperationLeaseCancelled(signal);
    const prior = priorProgress?.docTypes?.[docType];
    // Watermarks (and the cumulative counts that belong to the same scan chain) are only valid
    // under the embedding-space revision that produced them. On mismatch — a model flip since the
    // last run — discard and rescan from the start (MUST-FIX 1b): resuming a stale end-of-corpus
    // watermark would "complete" instantly with zero embeds into the new space.
    const priorIsCurrentRevision = !scoped && !opts.dryRun && prior?.watermarkEmbedRevision === embedRevision;
    const initialWatermark = priorIsCurrentRevision ? (prior?.watermark ?? null) : null;
    const base = priorIsCurrentRevision
      ? {
          candidatesSeen: prior?.candidatesSeen ?? 0,
          embedded: prior?.embedded ?? 0,
          reusedInSpace: prior?.reusedInSpace ?? 0,
          failed: prior?.failed ?? 0
        }
      : { candidatesSeen: 0, embedded: 0, reusedInSpace: 0, failed: 0 };
    const state = freshDocTypeRunState(docType, initialWatermark);
    const ctx: RunContext = {
      userId,
      symbols,
      dryRun: opts.dryRun,
      embedRevision,
      leaseGuard,
      throwIfCancelled: () => {
        throwIfOperationLeaseCancelled(signal);
        // Model-drift guard (MUST-FIX 1e), re-checked at every per-item boundary: a mid-run
        // active-model change means subsequent storeDocument calls would target a DIFFERENT
        // space than this run's watermarks/completion accounting assume. Abort the whole run.
        const nowActive = activeEmbeddingModel(userId);
        if (nowActive !== embedModel) throw new ModelDriftAbort(embedModel, nowActive);
      },
      consumeMaxTexts: (count = 1) => {
        if (remainingMaxTexts === undefined) return;
        remainingMaxTexts -= count;
        if (remainingMaxTexts <= 0) {
          stoppedForCap = true;
          state.stoppedForCap = true;
          throw new MaxTextsReachedError();
        }
      },
      persistDocTypeProgress: (s) => persistRunning(docType, s, base)
    };

    try {
      if (docType === "sec-filings") await reembedSecFilings(ctx, state);
      else if (docType === "earningscalls-transcripts") await reembedEarningsCallsTranscripts(ctx, state);
      else if (docType === "insider-form4") await reembedInsiderForm4(ctx, state);
      else await reembedExperienceMemory(ctx, state);
    } catch (error) {
      if (error instanceof MaxTextsReachedError) {
        // Clean, expected stop — not an error. Progress already persisted per-item.
      } else if (error instanceof BudgetExhaustedStop) {
        stoppedForBudget = true;
        state.stoppedForBudget = true;
      } else if (error instanceof ModelDriftAbort) {
        driftError = error.message;
        console.error(`[corpus-reembed] ${docType}:`, error.message);
        audit("corpus_reembed_error", { docType, error: error.message }, userId);
      } else {
        throwIfOperationLeaseCancelled(signal); // rethrow lease loss immediately, unmasked
        console.error(`[corpus-reembed] ${docType} run failed:`, error instanceof Error ? error.message : String(error));
        state.failed += 1;
        audit("corpus_reembed_error", { docType, error: error instanceof Error ? error.message : String(error) }, userId);
      }
    }

    persistRunning(docType, state, base);
    results.push({
      docType,
      candidatesSeen: state.candidatesSeen,
      embedded: state.embedded,
      reusedInSpace: state.reusedInSpace,
      failed: state.failed,
      completed: state.completed,
      stoppedForBudget: state.stoppedForBudget
    });

    // Shared daily fuses / invocation cap / model drift — stop the whole run, not just this docType.
    if (state.stoppedForBudget || stoppedForCap || driftError) break;
  }

  const finalStatus: ReembedOutcomeStatus = driftError
    ? "error"
    : stoppedForBudget
      ? "stopped-budget"
      : stoppedForCap
        ? "stopped-cap"
        : "completed";
  // Dry runs and symbol-scoped runs persist NOTHING (same contract as persistRunning above) —
  // counts return in the response, and the stored status/watermarks stay exactly as the last
  // full-corpus real run left them.
  if (!opts.dryRun && !scoped) {
    const now = new Date().toISOString();
    const existing = readProgress();
    writeProgress({
      updatedAt: now,
      status: finalStatus,
      embedModel,
      embedRevision,
      dryRun: false,
      docTypes: existing?.docTypes ?? {},
      ...(driftError ? { error: driftError } : {})
    });
  }
  audit("corpus_reembed_run", { dryRun: opts.dryRun, scoped, embedModel, embedRevision, docTypes: results, ...(driftError ? { error: driftError } : {}) }, userId);

  return {
    dryRun: opts.dryRun,
    embedModel,
    embedRevision,
    stoppedForBudget,
    stoppedForCap,
    ...(driftError ? { error: driftError } : {}),
    docTypes: results
  };
}

/** Fire-and-forget entry point for the admin route's real (non-dry-run) POST. Returns immediately
 *  with whether the durable RAG_REINDEX lease was acquired; the run itself continues in the
 *  background with progress persisted for GET polling. */
export function startCorpusReembedRun(opts: RunCorpusReembedOptions = {}): OperationLeaseStartResult {
  return startDetachedOperationLease(
    { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: "corpus-reembed" },
    async (claim, signal) => {
      await runCorpusReembedLocked({ ...opts, dryRun: false }, claim, signal);
    },
    (outcome) => {
      if (!outcome.ok) {
        console.error(
          "[corpus-reembed] detached run failed:",
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
        );
      }
    }
  );
}

/** Awaited, side-effect-free (no embeds) dry-run entry point — returns counts directly instead of
 *  polling progress. Still serialized under the same lease (never races a real run reading/writing
 *  watermarks) and never persists any watermark advance. */
export async function runCorpusReembedDryRun(
  opts: RunCorpusReembedOptions = {}
): Promise<{ acquired: boolean; busy?: OperationLeaseBusy; result?: CorpusReembedRunResult }> {
  const guarded = await runWithOperationLease(
    { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: "corpus-reembed-dry-run" },
    async (claim, signal) => runCorpusReembedLocked({ ...opts, dryRun: true }, claim, signal)
  );
  if (!guarded.acquired) return { acquired: false, busy: guarded.busy };
  return { acquired: true, result: guarded.value };
}

/**
 * Test-only: an AWAITED (non-fire-and-forget) real run. Production code uses
 * `startCorpusReembedRun` for real runs (the HTTP request must return immediately); awaiting a
 * detached promise from a test is fragile, so this exposes the same locked implementation through
 * the awaited `runWithOperationLease` wrapper `runCorpusReembedDryRun` already uses, with
 * `dryRun: false`.
 */
export async function runCorpusReembedForTest(
  opts: RunCorpusReembedOptions = {}
): Promise<{ acquired: boolean; busy?: OperationLeaseBusy; result?: CorpusReembedRunResult }> {
  const guarded = await runWithOperationLease(
    { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: "corpus-reembed" },
    async (claim, signal) => runCorpusReembedLocked({ ...opts, dryRun: false }, claim, signal)
  );
  if (!guarded.acquired) return { acquired: false, busy: guarded.busy };
  return { acquired: true, result: guarded.value };
}

// ── Legacy-embedding-space purge ─────────────────────────────────────────────────

export interface PurgeLegacyEmbeddingSpaceOptions {
  docTypes?: CorpusReembedDocType[];
  confirm: string;
  dryRun?: boolean;
  userId?: string;
}

export interface PurgeLegacyEmbeddingSpaceResult {
  ok: boolean;
  refused?: string;
  purged: number;
  docTypes: CorpusReembedDocType[];
}

/** NOTE ON SCOPE: despite the token's historical name, this purge removes vectors from EVERY
 *  non-current embedding space for the covered docTypes — anything whose committed
 *  `embed_revision` differs from the currently-active one — not only voyage-finance-2's. The
 *  token string is kept for operator/runbook continuity; the docs and refusal messages state the
 *  real scope (2026-07-18 adversarial review). */
const PURGE_CONFIRM_TOKEN = "purge-voyage-vectors";

interface LegacyReceiptRow {
  vector_id: string;
  commit_id: string;
}

function legacyReceiptsFor(sourceTag: string, currentEmbedRevision: string): LegacyReceiptRow[] {
  return getDb().prepare(`
    SELECT o.vector_id AS vector_id, o.commit_id AS commit_id
    FROM chunk_occurrences o
    JOIN vector_ingest_commits c ON c.id = o.commit_id
    WHERE c.state = 'committed' AND c.source = ? AND c.embed_revision != ?
  `).all(sourceTag, currentEmbedRevision) as LegacyReceiptRow[];
}

/**
 * Retire the local ledger receipts of purged commits, atomically per docType (2026-07-18
 * adversarial review, MUST-FIX 1): once the provider vectors are deleted, leaving the commits
 * `committed` would (a) make every reconcile/drift report permanently flag receipt-without-vector
 * ghosts, and (b) let a future flip BACK to a purged space `reusedCommitted` against vectors that
 * no longer exist — silently completing with nothing retrievable. Marks the commits aborted,
 * removes their occurrence receipts, and clears their active-head rows so
 * `committedVectorCommitDisposition` reports not_committed and a re-ingest starts clean.
 */
function retirePurgedCommitReceipts(commitIds: string[]): void {
  if (commitIds.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  const BATCH = 400; // stay under SQLite's 999-variable ceiling
  db.transaction(() => {
    for (let i = 0; i < commitIds.length; i += BATCH) {
      const batch = commitIds.slice(i, i + BATCH);
      const ph = batch.map(() => "?").join(",");
      db.prepare(`
        UPDATE vector_ingest_commits
        SET state = 'aborted', lease_expires_at = NULL, updated_at = ?
        WHERE id IN (${ph})
      `).run(now, ...batch);
      db.prepare(`DELETE FROM chunk_occurrences WHERE commit_id IN (${ph})`).run(...batch);
      db.prepare(`DELETE FROM vector_document_heads WHERE commit_id IN (${ph})`).run(...batch);
    }
  })();
}

async function purgeLegacyEmbeddingSpaceLocked(
  opts: PurgeLegacyEmbeddingSpaceOptions,
  claim: OperationLeaseClaim,
  signal: AbortSignal
): Promise<PurgeLegacyEmbeddingSpaceResult> {
  const userId = opts.userId ?? "local";
  const docTypes = resolveDocTypes(opts.docTypes);

  if (opts.confirm !== PURGE_CONFIRM_TOKEN) {
    return { ok: false, refused: `confirm must equal "${PURGE_CONFIRM_TOKEN}"`, purged: 0, docTypes };
  }

  const embedModel = activeEmbeddingModel(userId);
  const embedRevision = embeddingSpaceRevisionForModel(embedModel);
  if (embedModel === VOYAGE_MODEL) {
    return {
      ok: false,
      refused: "active embedding model is still voyage-finance-2 — nothing to purge (would delete the current space).",
      purged: 0,
      docTypes
    };
  }

  const progress = readProgress();
  const purgeableDocTypes = docTypes.filter((docType) => DOC_TYPE_SOURCE_TAG[docType]); // excludes experience-memory
  for (const docType of purgeableDocTypes) {
    const docProgress = progress?.docTypes?.[docType];
    // The stamp is trustworthy only because full-corpus scans alone can write it: symbol-scoped
    // runs and dry runs persist nothing (see persistRunning), a model flip restarts the watermark
    // chain (watermarkEmbedRevision), and `failed` is cumulative across resumes — so this gate
    // holds unless a genuinely complete, failure-free scan of the WHOLE docType finished under
    // the currently-active space (2026-07-18 adversarial review, MUST-FIX 1; exploit + fix proven
    // in test/corpus-reembed-adversarial.test.ts).
    const completeUnderCurrentSpace =
      docProgress?.status === "completed" &&
      docProgress.completedForEmbedRevision === embedRevision &&
      !docProgress.failed;
    if (!completeUnderCurrentSpace) {
      return {
        ok: false,
        refused: `docType "${docType}" has not completed a FULL corpus-reembed run under the current embedding space (${embedRevision}) with zero failures; refusing to purge non-current-space vectors until it does. (Note: this purge removes ALL non-current embedding spaces for the covered docTypes, not only voyage-finance-2.)`,
        purged: 0,
        docTypes
      };
    }
  }

  const leaseGuard: VectorStoreLeaseGuard = {
    signal,
    assertOwnership: () => {
      throwIfOperationLeaseCancelled(signal);
      assertOperationLeaseOwnership(claim);
    }
  };

  let purged = 0;
  for (const docType of purgeableDocTypes) {
    throwIfOperationLeaseCancelled(signal);
    const sourceTag = DOC_TYPE_SOURCE_TAG[docType]!;
    const receipts = legacyReceiptsFor(sourceTag, embedRevision);
    if (receipts.length === 0) continue;
    if (opts.dryRun) {
      purged += receipts.length;
      continue;
    }
    const result = await purgeManagedVectorsByIds(receipts.map((r) => r.vector_id), { userId, leaseGuard });
    purged += result.deleted;
    // Retire the ledger receipts ONLY after the provider delete succeeded for this docType —
    // a provider failure keeps receipts intact so a purge retry re-targets the same exact ids.
    retirePurgedCommitReceipts([...new Set(receipts.map((r) => r.commit_id))]);
  }

  audit("corpus_reembed_purge_legacy", { dryRun: Boolean(opts.dryRun), embedModel, embedRevision, docTypes: purgeableDocTypes, purged }, userId);
  return { ok: true, purged, docTypes: purgeableDocTypes };
}

export async function purgeLegacyEmbeddingSpace(
  opts: PurgeLegacyEmbeddingSpaceOptions
): Promise<{ acquired: boolean; busy?: OperationLeaseBusy; result?: PurgeLegacyEmbeddingSpaceResult }> {
  const guarded = await runWithOperationLease(
    { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: "corpus-reembed-purge" },
    async (claim, signal) => purgeLegacyEmbeddingSpaceLocked(opts, claim, signal)
  );
  if (!guarded.acquired) return { acquired: false, busy: guarded.busy };
  return { acquired: true, result: guarded.value };
}

// ── Operator watermark reset (MUST-FIX 1d) ──────────────────────────────────────

/**
 * Explicitly reset per-docType progress (watermark, cumulative counts, completion stamp) so the
 * next run performs a fresh full-corpus scan. The intended operator flow after failures:
 * reset → full run (already-committed content reuses for free; previously-failed content gets
 * retried) → purge gate re-evaluates against the fresh, failure-free scan. Serialized under the
 * same durable lease so it can never yank watermarks out from under a live run.
 */
export async function resetCorpusReembedWatermarks(
  docTypes?: CorpusReembedDocType[]
): Promise<{ acquired: boolean; busy?: OperationLeaseBusy; reset?: CorpusReembedDocType[] }> {
  const targets = resolveDocTypes(docTypes);
  const guarded = await runWithOperationLease(
    { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: "corpus-reembed-reset" },
    async () => {
      const existing = readProgress();
      if (!existing) return targets;
      const nextDocTypes = { ...existing.docTypes };
      for (const docType of targets) delete nextDocTypes[docType];
      writeProgress({ ...existing, updatedAt: new Date().toISOString(), docTypes: nextDocTypes });
      audit("corpus_reembed_reset", { docTypes: targets });
      return targets;
    }
  );
  if (!guarded.acquired) return { acquired: false, busy: guarded.busy };
  return { acquired: true, reset: guarded.value };
}
