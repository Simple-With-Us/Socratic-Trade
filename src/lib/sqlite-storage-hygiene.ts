// sqlite-storage-hygiene.ts — WAL checkpoint, SQLite maintenance pragmas, and
// incremental free-page reclaim for the production SQLite file.
//
// The file is large (multi-gigabyte) and Litestream is replicating the WAL.
// This lane does NOT delete rows by age (Jay policy, 2026-10-15): strategy runs,
// run requests, task journal, logs, embed stage, coverage runs, and market-data
// history are kept forever.  Orders, fills, positions, approvals, transfers, and
// settings remain protected by name if a future maintainer reintroduces deletes.
//
// Free pages go back to the OS only when auto_vacuum is already INCREMENTAL,
// via a capped incremental_vacuum.  A full file rewrite is never issued: on a
// live multi-gigabyte database that rewrite would block writers and burst the
// replica.  Fresh databases arm INCREMENTAL before the first table
// (db.ts armIncrementalAutoVacuumIfEmpty).  Existing files stay as they are.

import { statSync, readdirSync } from "fs";
import { join } from "path";
import { databasePath, getDb } from "./db";
import { yieldEventLoop } from "./slow-sync-guard";

/** Tables this module must never delete.  Orders, fills, positions, approvals,
 *  account-transfer learning rows, and the settings rows that hold HWM inputs. */
export const MONEY_PATH_TABLES = [
  "fill_events",
  "order_replacements",
  "order_replacements_v22",
  "trade_proposals",
  "portfolio_snapshots",
  "position_stop_plans",
  "position_stop_plan_open_brackets",
  "pending_bracket_teardowns",
  "broker_protective_stops",
  "broker_stop_placement_intents",
  "synthetic_trailing_stops",
  "take_profit_trims",
  "settings",
  "connected_accounts",
  "account_strategy_state",
  "learned_context",
  "learned_context_pending"
] as const;

/** Price, fundamentals, filings, transcripts, SEC facts, and document-chunk tables.
 *  Jay policy: never delete market-data history by age from the storage-hygiene lane. */
export const MARKET_DATA_HISTORY_TABLES = [
  "history_cache_eod",
  "imported_price_eod",
  "symbol_field_latest",
  "historical_fundamentals",
  "fundamental_revisions",
  "sec_facts",
  "sec_filings",
  "sec_artifacts",
  "sec_insider_transactions",
  "sec_13f_holdings",
  "document_chunks",
  "document_chunks_fts_index",
  "chunk_occurrences",
  "document_abstracts",
  "earningscalls_transcripts",
  "earningscalls_event_index",
  "earningscalls_symbol_checks",
  "fmp_transcript_versions",
  "fmp_transcript_derived_artifacts"
] as const;

const MONEY_PATH_SET = new Set<string>(MONEY_PATH_TABLES);
const MARKET_DATA_HISTORY_SET = new Set<string>(MARKET_DATA_HISTORY_TABLES);

export function isMarketDataHistoryTable(table: string): boolean {
  if (MARKET_DATA_HISTORY_SET.has(table)) return true;
  return table.startsWith("document_chunks_fts");
}

/** @deprecated Retention deletes were removed 2026-10-15; kept empty for compatibility. */
export const RETENTION_TARGETS: readonly never[] = [];

export const HYGIENE_FULL_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const HYGIENE_CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000;
export const WAL_TRUNCATE_MIN_BYTES = 8 * 1024 * 1024;
export const LITESTREAM_MAX_LAG_SECONDS = 180;
export const INCREMENTAL_VACUUM_PAGE_CAP = 128;

const REPORT_KEY = "storage-hygiene:lastReport";
const FULL_AT_KEY = "storage-hygiene:lastFullAt";
const CHECKPOINT_AT_KEY = "storage-hygiene:lastCheckpointAt";

/** Pages analyzed per `ANALYZE` pass — avoids an unbounded full scan on large DBs (see `runMaintenancePragmas`). */
export const STORAGE_HYGIENE_ANALYZE_PAGE_LIMIT = 400;

/**
 * Human-readable retention notes for `/api/ops/snapshot` size estimates.  Reflects Jay policy
 * (2026-10-15): no scheduled TTL/cap deletes on these tables; `pruneTaskJournal`, embed sweeps,
 * and `api_health_log` lane trims are disabled.  `embed_stage` still drops rows after successful
 * Pinecone delivery (`deleteStagedEmbeddings`) — that is not storage-hygiene deletion.
 */
const RETAIN_REASON: Record<string, string> = {
  history_cache_eod: "durable price history (no age deletion)",
  llm_usage: "lifetime LLM usage retention",
  strategy_runs: "lifetime strategy run retention",
  strategy_run_requests: "lifetime run request retention",
  task_journal: "no scheduled deletes (lifetime retention)",
  embed_stage: "no hygiene TTL/cap; cleared after embed delivery only",
  api_health_log: "no scheduled deletes (lifetime retention)",
  api_health_error_patterns: "lifetime API health log retention",
  sec_ingest_task_attempts: "lifetime SEC ingest attempt retention",
  enrichment_coverage_runs: "lifetime enrichment coverage retention",
  enrichment_coverage_fields: "lifetime enrichment coverage retention",
  audit_events: "lifetime audit retention",
  provider_dispatch_attempts: "lifetime provider dispatch retention",
  provider_usage_outbox: "lifetime provider usage outbox retention",
  portfolio_snapshots: "lifetime portfolio snapshot retention",
  ...Object.fromEntries(MARKET_DATA_HISTORY_TABLES.map((table) => [table, "market-data history retention"])),
  document_chunks_fts: "market-data history retention",
  document_chunks_fts_data: "market-data history retention",
  document_chunks_fts_idx: "market-data history retention",
  document_chunks_fts_content: "market-data history retention",
  document_chunks_fts_docsize: "market-data history retention",
  document_chunks_fts_config: "market-data history retention"
};

export type StorageCategory =
  | "audit"
  | "runs"
  | "coverage"
  | "task_journal"
  | "quote_bar_cache"
  | "embeddings"
  | "logs"
  | "money_path"
  | "market_data_history"
  | "other";

const CATEGORY_BY_TABLE: Record<string, StorageCategory> = {
  audit_events: "audit",
  provider_dispatch_attempts: "logs",
  provider_usage_outbox: "logs",
  strategy_runs: "runs",
  strategy_run_requests: "runs",
  enrichment_coverage_runs: "coverage",
  enrichment_coverage_fields: "coverage",
  task_journal: "task_journal",
  history_cache_eod: "quote_bar_cache",
  symbol_field_latest: "quote_bar_cache",
  imported_price_eod: "quote_bar_cache",
  embed_stage: "embeddings",
  document_chunks: "embeddings",
  document_chunks_fts: "embeddings",
  api_health_log: "logs",
  api_health_error_patterns: "logs",
  sec_ingest_task_attempts: "logs",
  llm_usage: "logs",
  lookahead_audit_findings: "logs"
};

/** Storage hygiene does not delete rows.  Call sites that still invoke this throw. */
export function assertPruneTableAllowed(table: string): void {
  if (MONEY_PATH_SET.has(table)) {
    throw new Error(`Refusing to delete money-path table ${table}`);
  }
  if (isMarketDataHistoryTable(table)) {
    throw new Error(`Refusing to delete market-data history table ${table}`);
  }
  throw new Error(`Storage hygiene does not delete rows (${table})`);
}

export type LitestreamObservation = "absent" | "fresh" | "stale" | "uncertain";

export function classifyLitestreamAge(ageSeconds: number | null, uncertain: boolean): LitestreamObservation {
  if (uncertain) return "uncertain";
  if (ageSeconds === null) return "absent";
  if (ageSeconds > LITESTREAM_MAX_LAG_SECONDS) return "stale";
  return "fresh";
}

export interface WalTruncateDecision {
  truncate: boolean;
  reason: string;
}

/** TRUNCATE only after PASSIVE has copied every frame and Litestream does not look stale. */
export function decideWalTruncate(input: {
  dryRun: boolean;
  passiveBusy: number;
  passiveLog: number;
  passiveCheckpointed: number;
  walBytes: number;
  litestream: LitestreamObservation;
}): WalTruncateDecision {
  if (input.dryRun) return { truncate: false, reason: "dry-run; checkpoint not executed" };
  if (input.passiveBusy !== 0) {
    return { truncate: false, reason: "readers still hold WAL frames" };
  }
  if (input.passiveCheckpointed < input.passiveLog) {
    return { truncate: false, reason: "passive checkpoint did not copy every frame" };
  }
  if (input.walBytes < WAL_TRUNCATE_MIN_BYTES) {
    return { truncate: false, reason: "wal below truncate floor" };
  }
  if (input.litestream === "stale") {
    return { truncate: false, reason: `litestream replica age exceeds ${LITESTREAM_MAX_LAG_SECONDS}s` };
  }
  if (input.litestream === "uncertain") {
    return { truncate: false, reason: "litestream replica age could not be read" };
  }
  if (input.litestream === "absent") {
    return {
      truncate: true,
      reason: "passive checkpoint copied every frame; no local litestream generation directory"
    };
  }
  return {
    truncate: true,
    reason: `passive checkpoint copied every frame and litestream lag is within ${LITESTREAM_MAX_LAG_SECONDS}s`
  };
}

export interface IncrementalVacuumDecision {
  run: boolean;
  pages: number;
  reason: string;
}

export function incrementalVacuumPragma(pages: number): string {
  if (!Number.isInteger(pages) || pages < 1 || pages > INCREMENTAL_VACUUM_PAGE_CAP) {
    throw new Error(`incremental_vacuum page count must be an integer from 1 to ${INCREMENTAL_VACUUM_PAGE_CAP}`);
  }
  return `incremental_vacuum(${pages})`;
}

export function decideIncrementalVacuum(input: {
  dryRun: boolean;
  autoVacuum: number;
  freelistCount: number;
}): IncrementalVacuumDecision {
  if (input.dryRun) {
    return { run: false, pages: 0, reason: "dry-run; free pages were not reclaimed" };
  }
  if (input.autoVacuum !== 2) {
    return {
      run: false,
      pages: 0,
      reason: "auto_vacuum is not INCREMENTAL; this job will not rewrite the database file"
    };
  }
  if (input.freelistCount <= 0) return { run: false, pages: 0, reason: "no free pages" };
  const pages = Math.min(input.freelistCount, INCREMENTAL_VACUUM_PAGE_CAP);
  return { run: true, pages, reason: `reclaiming ${pages} free pages` };
}

export interface CheckpointOutcome {
  busy: number;
  log: number;
  checkpointed: number;
}

export interface StorageObjectSize {
  name: string;
  kind: "table" | "index";
  category: StorageCategory;
  bytes: number;
  pages: number;
  prunable: boolean;
  retainReason: string | null;
}

/** @deprecated Row retention estimates were removed 2026-10-15. */
export interface StoragePruneEstimate {
  id: string;
  table: string;
  category: StorageCategory;
  retentionDays: number;
  eligibleRows: number;
  estimatedReclaimBytes: number;
  deletedRows: number;
}

export interface StorageHygieneReport {
  generatedAt: string;
  dryRun: boolean;
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  freelistBytes: number;
  dbSizeBytes: number;
  walSizeBytes: number;
  autoVacuum: "none" | "full" | "incremental" | "unknown";
  dbstatAvailable: boolean;
  expectedReclaimBytes: number;
  expectedFileShrinkBytes: number;
  fileShrinkNote: string;
  deletedRows: number;
  errors: string[];
  checkpoint: {
    passive: CheckpointOutcome | null;
    truncateRan: boolean;
    truncateReason: string;
  };
  incrementalVacuum: IncrementalVacuumDecision;
  auditPrune: {
    eligibleRows: number;
    estimatedReclaimBytes: number;
    note: string;
  };
  tables: StorageObjectSize[];
  estimates: StoragePruneEstimate[];
  moneyPathProtected: string[];
}

export interface StorageHygieneOptions {
  now?: Date;
  dryRun?: boolean;
  yieldFn?: () => Promise<void>;
  litestreamAgeSeconds?: number | null;
  litestreamUncertain?: boolean;
  checkpoint?: (mode: "PASSIVE" | "TRUNCATE") => CheckpointOutcome;
  /** Overrides the on-disk WAL size for the truncate decision.  Production omits this. */
  walBytes?: number;
  skipSizeWalk?: boolean;
}

function resolveDryRun(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  return process.env.SQLITE_STORAGE_HYGIENE_DRY_RUN === "1";
}

function autoVacuumName(mode: number): StorageHygieneReport["autoVacuum"] {
  if (mode === 0) return "none";
  if (mode === 1) return "full";
  if (mode === 2) return "incremental";
  return "unknown";
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Directories visited before the walk stops and reports uncertain.  Production
 *  `ltx/0` holds 1,000+ files, so the cap is directories, not directory entries. */
const LITESTREAM_WALK_MAX_DIRECTORIES = 80;
/** Large LTX directories are named `<minTXID>-<maxTXID>.ltx`.  Lexicographic order
 *  matches write order, so a wide directory stats this many highest names. */
const LITESTREAM_DIR_STAT_SAMPLE = 8;

function highestNames(names: readonly string[], sample: number): string[] {
  if (names.length <= sample) return [...names];
  const top: string[] = [];
  for (const name of names) {
    if (top.length < sample) {
      top.push(name);
      if (top.length === sample) top.sort();
      continue;
    }
    if (name > top[0]) {
      top[0] = name;
      top.sort();
    }
  }
  return top;
}

/** Best-effort age of the Litestream generation directory next to the database.
 *  A walk that stops early is "uncertain", which refuses TRUNCATE.  Wide LTX
 *  directories contribute their highest-named files instead of the first entries
 *  `readdir` happens to return. */
export function readLitestreamReplicaAge(dbPath: string, now = Date.now()): { ageSeconds: number | null; uncertain: boolean } {
  const root = `${dbPath}-litestream`;
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    return { ageSeconds: null, uncertain: false };
  }
  if (!rootStat.isDirectory()) return { ageSeconds: null, uncertain: false };
  let newest = 0;
  let directories = 0;
  let truncated = false;
  const pending = [root];
  while (pending.length > 0) {
    if (directories >= LITESTREAM_WALK_MAX_DIRECTORIES) {
      truncated = true;
      break;
    }
    const dir = pending.pop();
    if (!dir) break;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      truncated = true;
      continue;
    }
    directories += 1;
    const fileNames: string[] = [];
    for (const entry of dirents) {
      if (entry.isDirectory()) pending.push(join(dir, entry.name));
      else fileNames.push(entry.name);
    }
    for (const name of highestNames(fileNames, LITESTREAM_DIR_STAT_SAMPLE)) {
      try {
        const stat = statSync(join(dir, name));
        if (stat.isFile() && stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch {
        continue;
      }
    }
  }
  if (newest === 0) return { ageSeconds: null, uncertain: truncated };
  return { ageSeconds: Math.max(0, Math.round((now - newest) / 1000)), uncertain: truncated };
}

function readJsonSetting<T>(key: string): T | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

function writeJsonSetting(key: string, value: unknown, nowIso: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, JSON.stringify(value), nowIso);
}

export function readCachedStorageHygieneReport(): StorageHygieneReport | null {
  const parsed = readJsonSetting<StorageHygieneReport>(REPORT_KEY);
  if (!parsed || typeof parsed.generatedAt !== "string" || typeof parsed.expectedReclaimBytes !== "number") {
    return null;
  }
  return parsed;
}

let dbstatAvailable: boolean | null = null;

function objectBytes(name: string): { bytes: number; pages: number } | null {
  if (dbstatAvailable === false) return null;
  try {
    const row = getDb()
      .prepare("SELECT COALESCE(SUM(pgsize), 0) AS bytes, COUNT(*) AS pages FROM dbstat WHERE name = ?")
      .get(name) as { bytes: number; pages: number };
    dbstatAvailable = true;
    return { bytes: Number(row.bytes) || 0, pages: Number(row.pages) || 0 };
  } catch {
    dbstatAvailable = false;
    return null;
  }
}

function categoryFor(name: string, tableName: string, kind: "table" | "index"): StorageCategory {
  const table = kind === "index" ? tableName : name;
  if (MONEY_PATH_SET.has(table)) return "money_path";
  const explicit = CATEGORY_BY_TABLE[table] ?? CATEGORY_BY_TABLE[name];
  if (explicit) return explicit;
  if (isMarketDataHistoryTable(table) || isMarketDataHistoryTable(name)) return "market_data_history";
  return "other";
}

function retainReasonFor(name: string, tableName: string, kind: "table" | "index"): string | null {
  const table = kind === "index" ? tableName : name;
  if (MONEY_PATH_SET.has(table)) return "money-path record";
  if (isMarketDataHistoryTable(table) || isMarketDataHistoryTable(name)) {
    return "market-data history retention";
  }
  return RETAIN_REASON[name] ?? RETAIN_REASON[table] ?? null;
}

async function listObjectSizes(yieldFn: () => Promise<void>, skip: boolean): Promise<StorageObjectSize[]> {
  if (skip) return [];
  const rows = getDb()
    .prepare(
      `SELECT name, type, tbl_name AS tblName
       FROM sqlite_master
       WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'`
    )
    .all() as Array<{ name: string; type: string; tblName: string }>;
  const sizes: StorageObjectSize[] = [];
  for (const row of rows) {
    const kind = row.type === "index" ? "index" : "table";
    const stat = objectBytes(row.name);
    sizes.push({
      name: row.name,
      kind,
      category: categoryFor(row.name, row.tblName, kind),
      bytes: stat?.bytes ?? 0,
      pages: stat?.pages ?? 0,
      prunable: false,
      retainReason: retainReasonFor(row.name, row.tblName, kind)
    });
    await yieldFn();
  }
  sizes.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const pinned = new Set<string>([
    ...MONEY_PATH_TABLES,
    ...MARKET_DATA_HISTORY_TABLES,
    "audit_events",
    "llm_usage",
    "strategy_runs",
    "strategy_run_requests",
    "task_journal",
    "api_health_log",
    "embed_stage",
    "enrichment_coverage_runs"
  ]);
  const picked: StorageObjectSize[] = [];
  const seen = new Set<string>();
  for (const row of sizes) {
    if (picked.length < 40 || pinned.has(row.name)) {
      picked.push(row);
      seen.add(row.name);
    }
  }
  return picked.filter((row) => seen.has(row.name)).sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

function runMaintenancePragmas(dryRun: boolean): void {
  if (dryRun) return;
  const db = getDb();
  db.pragma(`analysis_limit=${STORAGE_HYGIENE_ANALYZE_PAGE_LIMIT}`);
  db.exec("ANALYZE");
  db.pragma("optimize");
}

function fileShrinkNote(dryRun: boolean, autoVacuum: StorageHygieneReport["autoVacuum"], pages: number): string {
  if (dryRun) {
    return "Dry-run: no maintenance pragmas, checkpoint, or free-page reclaim ran.";
  }
  if (autoVacuum !== "incremental") {
    return "auto_vacuum is not INCREMENTAL, so this job will not rewrite the database file to shrink it.";
  }
  if (pages <= 0) return "auto_vacuum is INCREMENTAL and there were no free pages to return this pass.";
  return `This pass asked SQLite to return ${pages} free pages.  A larger freelist waits for later passes.`;
}

function defaultCheckpoint(mode: "PASSIVE" | "TRUNCATE"): CheckpointOutcome {
  const rows = getDb().pragma(`wal_checkpoint(${mode})`) as Array<{
    busy?: number;
    log?: number;
    checkpointed?: number;
  }>;
  const row = rows[0] ?? {};
  return {
    busy: Number(row.busy) || 0,
    log: Number(row.log) || 0,
    checkpointed: Number(row.checkpointed) || 0
  };
}

function readCoreStats(): {
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  autoVacuumMode: number;
  dbSizeBytes: number;
  walSizeBytes: number;
} {
  const db = getDb();
  const dbPath = databasePath();
  return {
    pageSize: Number(db.pragma("page_size", { simple: true })) || 0,
    pageCount: Number(db.pragma("page_count", { simple: true })) || 0,
    freelistCount: Number(db.pragma("freelist_count", { simple: true })) || 0,
    autoVacuumMode: Number(db.pragma("auto_vacuum", { simple: true })) || 0,
    dbSizeBytes: fileBytes(dbPath),
    walSizeBytes: fileBytes(`${dbPath}-wal`)
  };
}

async function runCheckpoint(options: StorageHygieneOptions, dryRun: boolean, walBytes: number): Promise<StorageHygieneReport["checkpoint"]> {
  if (dryRun) {
    return { passive: null, truncateRan: false, truncateReason: "dry-run; checkpoint not executed" };
  }
  const checkpoint = options.checkpoint ?? defaultCheckpoint;
  const passive = checkpoint("PASSIVE");
  let litestream: LitestreamObservation;
  if (options.litestreamAgeSeconds !== undefined || options.litestreamUncertain) {
    litestream = classifyLitestreamAge(options.litestreamAgeSeconds ?? null, Boolean(options.litestreamUncertain));
  } else {
    const observed = readLitestreamReplicaAge(databasePath());
    litestream = classifyLitestreamAge(observed.ageSeconds, observed.uncertain);
  }
  const decision = decideWalTruncate({
    dryRun: false,
    passiveBusy: passive.busy,
    passiveLog: passive.log,
    passiveCheckpointed: passive.checkpointed,
    walBytes,
    litestream
  });
  if (!decision.truncate) return { passive, truncateRan: false, truncateReason: decision.reason };
  checkpoint("TRUNCATE");
  return { passive, truncateRan: true, truncateReason: decision.reason };
}

export async function runStorageHygiene(options: StorageHygieneOptions = {}): Promise<StorageHygieneReport> {
  const now = options.now ?? new Date();
  const dryRun = resolveDryRun(options.dryRun);
  const yieldFn = options.yieldFn ?? yieldEventLoop;
  const errors: string[] = [];

  const tables = await listObjectSizes(yieldFn, Boolean(options.skipSizeWalk));

  try {
    runMaintenancePragmas(dryRun);
  } catch (error) {
    errors.push(`maintenance pragmas: ${error instanceof Error ? error.message : String(error)}`);
  }

  const beforeVacuum = readCoreStats();
  const vacuumDecision = decideIncrementalVacuum({
    dryRun,
    autoVacuum: beforeVacuum.autoVacuumMode,
    freelistCount: beforeVacuum.freelistCount
  });
  let pagesReturned = 0;
  if (vacuumDecision.run) {
    const pageCountBefore = beforeVacuum.pageCount;
    getDb().pragma(incrementalVacuumPragma(vacuumDecision.pages));
    pagesReturned = Math.max(0, pageCountBefore - (Number(getDb().pragma("page_count", { simple: true })) || 0));
  }
  const after = readCoreStats();
  const checkpoint = await runCheckpoint(options, dryRun, options.walBytes ?? beforeVacuum.walSizeBytes);
  const autoVacuum = autoVacuumName(after.autoVacuumMode);
  const report: StorageHygieneReport = {
    generatedAt: now.toISOString(),
    dryRun,
    pageSize: after.pageSize,
    pageCount: after.pageCount,
    freelistCount: after.freelistCount,
    freelistBytes: after.freelistCount * after.pageSize,
    dbSizeBytes: after.dbSizeBytes,
    walSizeBytes: after.walSizeBytes,
    autoVacuum,
    dbstatAvailable: dbstatAvailable !== false,
    expectedReclaimBytes: 0,
    expectedFileShrinkBytes: pagesReturned * after.pageSize,
    fileShrinkNote: fileShrinkNote(dryRun, autoVacuum, vacuumDecision.run ? vacuumDecision.pages : 0),
    deletedRows: 0,
    errors,
    checkpoint,
    incrementalVacuum: vacuumDecision,
    auditPrune: {
      eligibleRows: 0,
      estimatedReclaimBytes: 0,
      note: "Storage hygiene does not delete audit rows.  The daily audit-prune lane owns age-based audit cleanup."
    },
    tables,
    estimates: [],
    moneyPathProtected: [...MONEY_PATH_TABLES]
  };
  writeJsonSetting(REPORT_KEY, report, report.generatedAt);
  return report;
}

async function runCheckpointOnly(options: StorageHygieneOptions, now: Date): Promise<StorageHygieneReport> {
  const cached = readCachedStorageHygieneReport();
  const stats = readCoreStats();
  const checkpoint = await runCheckpoint(options, false, stats.walSizeBytes);
  const base: StorageHygieneReport = cached ?? {
    generatedAt: now.toISOString(),
    dryRun: false,
    pageSize: stats.pageSize,
    pageCount: stats.pageCount,
    freelistCount: stats.freelistCount,
    freelistBytes: stats.freelistCount * stats.pageSize,
    dbSizeBytes: stats.dbSizeBytes,
    walSizeBytes: stats.walSizeBytes,
    autoVacuum: autoVacuumName(stats.autoVacuumMode),
    dbstatAvailable: dbstatAvailable !== false,
    expectedReclaimBytes: 0,
    expectedFileShrinkBytes: 0,
    fileShrinkNote: "Checkpoint only.  Full maintenance pass has not run yet.",
    deletedRows: 0,
    errors: [],
    checkpoint,
    incrementalVacuum: { run: false, pages: 0, reason: "checkpoint-only pass" },
    auditPrune: {
      eligibleRows: 0,
      estimatedReclaimBytes: 0,
      note: "not estimated on a checkpoint-only pass"
    },
    tables: [],
    estimates: [],
    moneyPathProtected: [...MONEY_PATH_TABLES]
  };
  const report: StorageHygieneReport = {
    ...base,
    generatedAt: now.toISOString(),
    pageSize: stats.pageSize,
    pageCount: stats.pageCount,
    freelistCount: stats.freelistCount,
    freelistBytes: stats.freelistCount * stats.pageSize,
    dbSizeBytes: stats.dbSizeBytes,
    walSizeBytes: fileBytes(`${databasePath()}-wal`),
    checkpoint
  };
  writeJsonSetting(REPORT_KEY, report, report.generatedAt);
  return report;
}

/** Same-process guard.  The scheduler fires this lane with `void` and does not
 *  await it, so the next 60s tick would otherwise start a second pass. */
let hygieneInFlight = false;

/** Test-only pause after the watermark claim and before the pass. */
export const storageHygieneTestHooks: { beforePass?: () => Promise<void> } = {};

function readSettingString(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Compare-and-set the cadence watermark before the pass starts.  A second
 *  process that still sees the old value loses and does not start work. */
function claimJsonString(key: string, observed: string | null, nowIso: string): boolean {
  const db = getDb();
  const claim = db.transaction(() => {
    const current = readSettingString(key);
    if (current !== observed) return false;
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, JSON.stringify(nowIso), nowIso);
    return true;
  });
  return claim.immediate();
}

/** Cadence: a full pass every 6 hours, and a WAL checkpoint every 10 minutes.
 *  SQLITE_STORAGE_HYGIENE_DISABLED=1 turns the lane off.
 *  SQLITE_STORAGE_HYGIENE_DRY_RUN=1 skips maintenance pragmas, checkpoint, and vacuum.
 *  The watermark is claimed before the await.  A thrown pass keeps that claim
 *  so the next tick does not start another full walk; the interval retries. */
export async function runStorageHygieneIfDue(nowMs: number = Date.now()): Promise<StorageHygieneReport | null> {
  if (process.env.SQLITE_STORAGE_HYGIENE_DISABLED === "1") return null;
  if (hygieneInFlight) return null;
  hygieneInFlight = true;
  try {
    const now = new Date(nowMs);
    const fullLast = readJsonSetting<string>(FULL_AT_KEY);
    const checkpointLast = readJsonSetting<string>(CHECKPOINT_AT_KEY);
    const fullMs = fullLast ? Date.parse(fullLast) : NaN;
    const checkpointMs = checkpointLast ? Date.parse(checkpointLast) : NaN;
    const fullDue = !Number.isFinite(fullMs) || nowMs - fullMs >= HYGIENE_FULL_INTERVAL_MS;
    const checkpointDue = !Number.isFinite(checkpointMs) || nowMs - checkpointMs >= HYGIENE_CHECKPOINT_INTERVAL_MS;
    if (!fullDue && !checkpointDue) return null;
    if (fullDue) {
      if (!claimJsonString(FULL_AT_KEY, typeof fullLast === "string" ? fullLast : null, now.toISOString())) return null;
      if (storageHygieneTestHooks.beforePass) await storageHygieneTestHooks.beforePass();
      const report = await runStorageHygiene({ now });
      if (!report.dryRun) writeJsonSetting(CHECKPOINT_AT_KEY, now.toISOString(), now.toISOString());
      return report;
    }
    if (resolveDryRun(undefined)) return null;
    if (!claimJsonString(CHECKPOINT_AT_KEY, typeof checkpointLast === "string" ? checkpointLast : null, now.toISOString())) {
      return null;
    }
    if (storageHygieneTestHooks.beforePass) await storageHygieneTestHooks.beforePass();
    return await runCheckpointOnly({}, now);
  } finally {
    hygieneInFlight = false;
  }
}
