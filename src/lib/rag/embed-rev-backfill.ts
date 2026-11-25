// embed-rev-backfill.ts — ST-4682 (OD-6, owner 2026-11-24): planner + bounded resumable driver for
// re-embedding the corpus population whose embeddingText changed when ST-4664 added the structured
// `[TICKER | FORM PERIOD | SECTION]` header to every `storeDocument` filing/transcript chunk.
//
// Why a revision bump needs a backfill at all: the bump (vector-db.ts `MANAGED_CONTEXT_EMBED_REV`
// = 4) makes the new header-bearing text the CURRENT managed space, and `storeDocument`'s
// committed-receipt reuse (`reusedCommitted` short-circuit, keyed by a commit id that embeds the
// embedding-space revision) naturally stops matching pre-header commits — but only once a document
// is touched again by live ingestion. This module counts the stale rows ahead of time (dry-run,
// DB-only, NO network) and drives the re-embed in bounded slices through the EXISTING embed path
// (`runCorpusReembedAwaited` → per-candidate `storeDocument`/`storeContexts`, with all of its
// ledger receipts, daily budget fuses, and batch pacing intact — this module adds no second
// write path).
//
// Safety properties:
//   - Dry-run by default. The plan reads only the local SQLite ledger (vector_ingest_commits);
//     it never opens a vector-store client, so `npx tsx scripts/backfill-embed-rev.ts` is safe
//     against any database file.
//   - The entry script refuses to run without an explicit `--db` path (no default DB), so it can
//     never accidentally open `data/app.db` relative to whatever cwd it was invoked from.
//   - Per-run budget caps (rows + estimated embedding tokens) and a hard stop after N failed
//     candidates; both are env knobs on the script, arguments on the API.
//   - A durable watermark in the settings table (`embedRevBackfill:progress`) records lifetime
//     totals for the TARGET embedding-space revision. On revision change the watermark is
//     discarded (same rule corpus-reembed's own watermarks follow), so a bump never silently
//     resumes stale accounting.
//   - Retired Pinecone-only lanes are never touched: the script refuses --execute unless the
//     effective write backend is Qdrant.
//
// This file performs no embedding/provider calls itself; the injected `runner` (production: the
// bounded corpus-reembed slice) owns all network behavior, which also makes the driver testable
// with a mocked embed path and no network.

import { audit, getDb, getInternalSetting, setInternalSetting } from "../db";
import {
  activeEmbeddingModel,
  currentManagedEmbedRevisionForModel,
  managedContextEmbedRev
} from "../vector-db";

export const EMBED_REV_BACKFILL_WATERMARK_KEY = "embedRevBackfill:progress";

/** Sources whose candidates the existing corpus-reembed scan can reconstruct and re-embed from
 *  local tables (sec-filings + earningscalls-transcripts in its DEFAULT docTypes; insider-form4
 *  only when explicitly selected, mirroring `DOC_TYPE_SOURCE_TAG` in corpus-reembed.ts). */
export const DEFAULT_BACKFILL_COVERED_SOURCES = ["sec-edgar", "earningscalls-dev"] as const;
export const OPTIONAL_BACKFILL_COVERED_SOURCES = ["insider-filing"] as const;

/** Parse the numeric representation revision out of a stamped embedding-space revision string
 *  (`"v4-baai-bge-m3"` → 4). Missing/empty/non-`v` stamps — pre-tag vectors, hand-edited rows —
 *  parse to 0, i.e. maximally stale. Never throws: a stored older revision must stay READABLE
 *  (retrieval admission compares a vector against its own receipt), it is only stale to reuse. */
export function parseEmbedRevisionNumber(revision: unknown): number {
  if (typeof revision !== "string") return 0;
  const m = /^v(\d+)/.exec(revision.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export interface EmbedRevCollectionPlan {
  /** Qdrant collection/namespace grouping (`vector_ingest_commits.vector_namespace`). */
  vectorNamespace: string;
  source: string;
  totalCommits: number;
  totalRows: number;
  staleCommits: number;
  staleRows: number;
  /** True when the existing embed path can reconstruct candidates for this source locally. */
  runnerCovers: boolean;
}

export interface EmbedRevPlan {
  /** The managed embedding-space revision the backfill targets (e.g. `v4-baai-bge-m3`). */
  targetEmbedRevision: string;
  /** Its numeric part (4). Rows stamped below this are stale to reuse. */
  targetRev: number;
  embedModel: string;
  collections: EmbedRevCollectionPlan[];
  staleCommits: number;
  staleRows: number;
  coverableStaleRows: number;
  /** Stale COMMITS the covered runners can reach; the driver feeds this count (not vector rows)
   *  to the runner's maxDocs, because the embed path enforces its text budget per document. */
  coverableStaleCommits: number;
  /** Rows stale but only re-embeddable by their live ingestion path (reported, never forced). */
  uncoverableStaleRows: number;
  /** One embedding input per stale coverable row; actual API calls are batched by the embed path. */
  estimatedEmbedCalls: number;
  estimatedTokens: number;
  tokensPerRow: number;
}

export interface PlanEmbedRevBackfillOptions {
  /** Extra/overriding set of source tags the runner covers (defaults to the sec-edgar +
   *  earningscalls-dev live-scan pair; pass a superset to account for `insider-form4` runs). */
  coveredSources?: readonly string[];
  /** Conservative average embed-input tokens per chunk row (header + body capped by
   *  DEFAULT_CONTEXT_MAX_CHARS ≈ 2400 chars ≈ 600 tokens at 4 chars/token). */
  tokensPerRow?: number;
  userId?: string;
}

/**
 * DB-only stale-population census. Groups `vector_ingest_commits` (state='committed') by
 * (vector_namespace, source) and flags rows whose stamped `embed_revision` numeric part is below
 * the managed target (rev 4). Reads no provider state, writes nothing.
 */
export function planEmbedRevBackfill(options: PlanEmbedRevBackfillOptions = {}): EmbedRevPlan {
  const userId = options.userId ?? "local";
  const targetRev = managedContextEmbedRev();
  const embedModel = activeEmbeddingModel(userId);
  const targetEmbedRevision = currentManagedEmbedRevisionForModel(embedModel);
  const covered = new Set<string>([
    ...DEFAULT_BACKFILL_COVERED_SOURCES,
    ...(options.coveredSources ?? [])
  ]);
  const tokensPerRow = Math.max(1, Math.floor(options.tokensPerRow ?? 600));

  const rows = getDb().prepare(`
    SELECT vector_namespace AS vector_namespace, source AS source,
           COUNT(*) AS total_commits,
           SUM(expected_vectors) AS total_rows,
           SUM(CASE WHEN CAST(substr(embed_revision, 2) AS INTEGER) < ? THEN 1 ELSE 0 END) AS stale_commits,
           SUM(CASE WHEN CAST(substr(embed_revision, 2) AS INTEGER) < ? THEN expected_vectors ELSE 0 END) AS stale_rows
    FROM vector_ingest_commits
    WHERE state = 'committed'
    GROUP BY vector_namespace, source
    ORDER BY vector_namespace, source
  `).all(targetRev, targetRev) as Array<{
    vector_namespace: string;
    source: string;
    total_commits: number;
    total_rows: number;
    stale_commits: number;
    stale_rows: number;
  }>;

  const collections: EmbedRevCollectionPlan[] = rows.map((row) => ({
    vectorNamespace: row.vector_namespace,
    source: row.source,
    totalCommits: row.total_commits,
    totalRows: row.total_rows,
    staleCommits: row.stale_commits,
    staleRows: row.stale_rows,
    runnerCovers: covered.has(row.source)
  }));

  const staleRows = collections.reduce((sum, c) => sum + c.staleRows, 0);
  const coverableStaleRows = collections.reduce((sum, c) => sum + (c.runnerCovers ? c.staleRows : 0), 0);
  const coverableStaleCommits = collections.reduce((sum, c) => sum + (c.runnerCovers ? c.staleCommits : 0), 0);
  return {
    targetEmbedRevision,
    targetRev,
    embedModel,
    collections,
    staleCommits: collections.reduce((sum, c) => sum + c.staleCommits, 0),
    staleRows,
    coverableStaleRows,
    coverableStaleCommits,
    uncoverableStaleRows: staleRows - coverableStaleRows,
    estimatedEmbedCalls: coverableStaleRows,
    estimatedTokens: coverableStaleRows * tokensPerRow,
    tokensPerRow
  };
}

// ── Watermark (settings table, durable across restarts) ─────────────────────────

export interface EmbedRevWatermark {
  /** Lifetime totals for the target embedding-space revision that produced this record. */
  targetEmbedRevision: string;
  slices: number;
  rowsConsumed: number;
  estimatedTokensConsumed: number;
  embeddedTotal: number;
  reusedTotal: number;
  failedTotal: number;
  lastReason: string;
  updatedAt: string;
}

export function readEmbedRevWatermark(targetEmbedRevision: string): EmbedRevWatermark | undefined {
  const stored = getInternalSetting<EmbedRevWatermark>(EMBED_REV_BACKFILL_WATERMARK_KEY);
  if (!stored || typeof stored !== "object") return undefined;
  if (stored.targetEmbedRevision !== targetEmbedRevision) return undefined; // discarded, stale chain
  if (
    typeof stored.slices !== "number" ||
    typeof stored.rowsConsumed !== "number" ||
    typeof stored.estimatedTokensConsumed !== "number"
  ) return undefined;
  return stored;
}

export function clearEmbedRevBackfillWatermark(): void {
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(EMBED_REV_BACKFILL_WATERMARK_KEY);
}

// ── Bounded driver ──────────────────────────────────────────────────────────────

/** Outcome of ONE bounded corpus-reembed slice. `completed` = every scanned docType reached the
 *  end of its candidate list; `stoppedForBudget` = a shared daily fuse refused further writes. */
export interface EmbedRevSliceResult {
  embedded: number;
  reused: number;
  failed: number;
  completed: boolean;
  stoppedForBudget: boolean;
}

/** `(maxDocs) => Promise<sliceResult | null>`; returning null means the durable lease was busy
 *  (another RAG_REINDEX operation owns it) and the driver must stop, not retry-loop. */
export type EmbedRevSliceRunner = (maxDocs: number) => Promise<EmbedRevSliceResult | null>;

export interface EmbedRevRunBudget {
  /** Max stale rows this invocation may consume (lifetime enforcement is the embed path's
   *  shared daily fuse, which this driver never bypasses). */
  maxRows: number;
  /** Max estimated embedding tokens this invocation may spend (rows × tokensPerRow). */
  maxEstimatedTokens: number;
  /** Hard stop once cumulative FAILED candidates across this invocation reach this count. */
  maxEmbedErrors: number;
  /** Candidates handed to the embed path per slice. */
  batchDocs: number;
}

export interface RunEmbedRevBackfillOptions {
  execute: boolean;
  runner: EmbedRevSliceRunner;
  budget?: Partial<EmbedRevRunBudget>;
  planOptions?: PlanEmbedRevBackfillOptions;
  userId?: string;
  onSlice?: (info: {
    slice: number;
    result: EmbedRevSliceResult;
    rowsConsumedThisSlice: number;
    plan: EmbedRevPlan;
  }) => void;
}

export interface EmbedRevRunOutcome {
  dryRun: boolean;
  /** Why the driver stopped: nothing-to-do | lease-busy | budget-rows | budget-tokens |
   *  embed-error-limit | no-progress | exhausted | error (never thrown past this boundary). */
  reason: string;
  slices: number;
  embedded: number;
  reused: number;
  failed: number;
  rowsConsumed: number;
  estimatedTokensConsumed: number;
  /** Lifetime totals including prior resumptions under the same target revision. */
  watermark: EmbedRevWatermark | undefined;
  finalPlan: EmbedRevPlan;
}

export function defaultEmbedRevBudget(): EmbedRevRunBudget {
  return {
    maxRows: 5_000,
    maxEstimatedTokens: 2_000_000,
    maxEmbedErrors: 5,
    batchDocs: 100
  };
}

/**
 * Dry-run (returns the plan, runs nothing) or bounded execute loop: each slice re-plans from the
 * local ledger after the previous one so consumption/budgets are counted against OBSERVED stale
 * rows, not a one-time estimate. All embed network work happens inside `runner`; this function is
 * pure orchestration + settings watermark accounting, and is fully unit-testable with a mock.
 */
export async function runEmbedRevBackfill(opts: RunEmbedRevBackfillOptions): Promise<EmbedRevRunOutcome> {
  const budget: EmbedRevRunBudget = { ...defaultEmbedRevBudget(), ...(opts.budget ?? {}) };
  const userId = opts.userId ?? "local";
  let plan = planEmbedRevBackfill({ ...opts.planOptions, userId });
  const watermarkKey = plan.targetEmbedRevision;

  let rowsConsumed = 0;
  let estimatedTokensConsumed = 0;
  let embedded = 0;
  let reused = 0;
  let failed = 0;
  let slices = 0;
  let reason = "nothing-to-do";

  if (!opts.execute) {
    return {
      dryRun: true,
      reason: plan.coverableStaleRows === 0 ? "nothing-to-do" : "dry-run",
      slices: 0, embedded: 0, reused: 0, failed: 0,
      rowsConsumed: 0, estimatedTokensConsumed: 0,
      watermark: readEmbedRevWatermark(watermarkKey),
      finalPlan: plan
    };
  }

  // Watermark totals are CUMULATIVE across resumed runs under the same target revision (same
  // accounting rule corpus-reembed's own progress state follows), so a restart after a crash adds
  // to the prior chain instead of forgetting previously-paid work.
  const prior = readEmbedRevWatermark(watermarkKey);
  const cumulative = (reasonStr: string): EmbedRevWatermark => ({
    targetEmbedRevision: watermarkKey,
    slices: (prior?.slices ?? 0) + slices,
    rowsConsumed: (prior?.rowsConsumed ?? 0) + rowsConsumed,
    estimatedTokensConsumed: (prior?.estimatedTokensConsumed ?? 0) + estimatedTokensConsumed,
    embeddedTotal: (prior?.embeddedTotal ?? 0) + embedded,
    reusedTotal: (prior?.reusedTotal ?? 0) + reused,
    failedTotal: (prior?.failedTotal ?? 0) + failed,
    lastReason: reasonStr,
    updatedAt: new Date().toISOString()
  });

  for (;;) {
    if (plan.coverableStaleRows === 0) {
      reason = "exhausted";
      break;
    }
    if (rowsConsumed >= budget.maxRows) { reason = "budget-rows"; break; }
    if (estimatedTokensConsumed >= budget.maxEstimatedTokens) { reason = "budget-tokens"; break; }

    // maxDocs is a DOCUMENT count: budget.batchDocs bounds docs, so cap by coverable
    // COMMITS, never by vector rows (one commit can carry many vectors, which would
    // overshoot the docs budget and skew the token estimate; Kody 68AxaW).
    const slice = await opts.runner(Math.min(budget.batchDocs, plan.coverableStaleCommits));
    slices += 1;
    if (slice === null) { reason = "lease-busy"; break; }
    embedded += slice.embedded;
    reused += slice.reused;
    failed += slice.failed;

    const staleBefore = plan.coverableStaleRows;
    plan = planEmbedRevBackfill({ ...opts.planOptions, userId });
    const rowsConsumedThisSlice = Math.max(0, staleBefore - plan.coverableStaleRows);
    rowsConsumed += rowsConsumedThisSlice;
    estimatedTokensConsumed += rowsConsumedThisSlice * plan.tokensPerRow;
    opts.onSlice?.({ slice: slices, result: slice, rowsConsumedThisSlice, plan });

    setInternalSetting(EMBED_REV_BACKFILL_WATERMARK_KEY, cumulative("running"));

    if (slice.failed > 0 && failed >= budget.maxEmbedErrors) { reason = "embed-error-limit"; break; }
    // No ledger movement AND no per-candidate accounting → the runner cannot make progress on
    // what remains (e.g. candidates its scans do not cover, or an all-skipped space). Stop loudly
    // instead of spinning; report says exactly what is left.
    if (rowsConsumedThisSlice === 0 && slice.embedded + slice.reused === 0) { reason = "no-progress"; break; }
    if (slice.stoppedForBudget) { reason = "embed-path-budget-fuse"; break; }
    if (plan.coverableStaleRows === 0) { reason = "exhausted"; break; }
  }

  // Persist the terminal reason (a loop that never reached a successful slice still records why,
  // under this revision only).
  setInternalSetting(EMBED_REV_BACKFILL_WATERMARK_KEY, cumulative(reason));
  audit("embed_rev_backfill_run", {
    slices, rowsConsumed, estimatedTokensConsumed, embedded, reused, failed, reason,
    targetEmbedRevision: watermarkKey, remainingCoverableStaleRows: plan.coverableStaleRows
  }, userId);
  return {
    dryRun: false,
    reason,
    slices,
    embedded,
    reused,
    failed,
    rowsConsumed,
    estimatedTokensConsumed,
    watermark: readEmbedRevWatermark(watermarkKey),
    finalPlan: plan
  };
}
