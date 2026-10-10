// db-enrichment-coverage.ts — durable enrichment cascade coverage reports (admin + ops).
// Schema: db.ts migration 94. One row per cascade run (as_of) with the full report JSON;
// field rows are normalized for (as_of, field) history without re-parsing the blob.
import "server-only";
import { getDb } from "./db";
import {
  getLastEnrichmentCoverageReport,
  type EnrichmentCoverageReport,
  type EnrichmentFieldCoverage
} from "./enrichment-coverage";

const DEFAULT_HISTORY_LIMIT = 30;
const MAX_PERSISTED_RUNS = 120;

export interface EnrichmentCoverageRunSummary {
  asOf: string;
  symbolCount: number;
  createdAt: string;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Persist one cascade coverage report and its per-field rows (idempotent on as_of). */
export function persistEnrichmentCoverageReport(
  report: EnrichmentCoverageReport,
  now: string = new Date().toISOString()
): void {
  const database = getDb();
  const insertRun = database.prepare(
    `INSERT INTO enrichment_coverage_runs (as_of, symbol_count, report_json, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(as_of) DO UPDATE SET
       symbol_count = excluded.symbol_count,
       report_json = excluded.report_json,
       created_at = excluded.created_at`
  );
  const insertField = database.prepare(
    `INSERT INTO enrichment_coverage_fields (
       as_of, field, filled_count, total_symbols, fill_rate,
       winning_sources_json, most_frequent_source, missing_symbols_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(as_of, field) DO UPDATE SET
       filled_count = excluded.filled_count,
       total_symbols = excluded.total_symbols,
       fill_rate = excluded.fill_rate,
       winning_sources_json = excluded.winning_sources_json,
       most_frequent_source = excluded.most_frequent_source,
       missing_symbols_json = excluded.missing_symbols_json`
  );
  const deleteFieldsForRun = database.prepare(
    `DELETE FROM enrichment_coverage_fields WHERE as_of = ?`
  );

  const persist = database.transaction(() => {
    insertRun.run(report.asOf, report.symbolCount, JSON.stringify(report), now);
    deleteFieldsForRun.run(report.asOf);
    const fieldRows: EnrichmentFieldCoverage[] = report.headlines
      ? [...report.fields, report.headlines]
      : report.fields;
    for (const row of fieldRows) {
      insertField.run(
        report.asOf,
        row.field,
        row.filledCount,
        row.totalSymbols,
        row.fillRate,
        JSON.stringify(row.winningSources),
        row.mostFrequentSource,
        JSON.stringify(row.missingSymbols)
      );
    }
    pruneOldRuns(database);
  });
  persist();
}

function pruneOldRuns(database: ReturnType<typeof getDb>): void {
  const row = database
    .prepare(`SELECT COUNT(*) AS n FROM enrichment_coverage_runs`)
    .get() as { n: number };
  if (row.n <= MAX_PERSISTED_RUNS) return;
  const excess = row.n - MAX_PERSISTED_RUNS;
  const stale = database
    .prepare(
      `SELECT as_of FROM enrichment_coverage_runs
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(excess) as Array<{ as_of: string }>;
  if (stale.length === 0) return;
  const placeholders = stale.map(() => "?").join(", ");
  const asOfList = stale.map((r) => r.as_of);
  database
    .prepare(`DELETE FROM enrichment_coverage_fields WHERE as_of IN (${placeholders})`)
    .run(...asOfList);
  database
    .prepare(`DELETE FROM enrichment_coverage_runs WHERE as_of IN (${placeholders})`)
    .run(...asOfList);
}

/** In-memory last report from the current process, else the latest durable row. */
export function resolveEnrichmentCoverageReport(): EnrichmentCoverageReport | null {
  return getLastEnrichmentCoverageReport() ?? loadLatestEnrichmentCoverageReport();
}

export function loadLatestEnrichmentCoverageReport(): EnrichmentCoverageReport | null {
  const row = getDb()
    .prepare(
      `SELECT report_json FROM enrichment_coverage_runs
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get() as { report_json: string } | undefined;
  if (!row?.report_json) return null;
  return parseJson<EnrichmentCoverageReport | null>(row.report_json, null);
}

export function listEnrichmentCoverageRunHistory(
  limit: number = DEFAULT_HISTORY_LIMIT
): EnrichmentCoverageRunSummary[] {
  const capped = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = getDb()
    .prepare(
      `SELECT as_of, symbol_count, created_at
       FROM enrichment_coverage_runs
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(capped) as Array<{ as_of: string; symbol_count: number; created_at: string }>;
  return rows.map((row) => ({
    asOf: row.as_of,
    symbolCount: row.symbol_count,
    createdAt: row.created_at
  }));
}

/** Field-level history for one tracked field, newest runs first. */
export function listEnrichmentCoverageFieldHistory(
  field: string,
  limit: number = DEFAULT_HISTORY_LIMIT
): Array<{
  asOf: string;
  filledCount: number;
  totalSymbols: number;
  fillRate: number;
  mostFrequentSource: string | null;
}> {
  const capped = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = getDb()
    .prepare(
      `SELECT as_of, filled_count, total_symbols, fill_rate, most_frequent_source
       FROM enrichment_coverage_fields
       WHERE field = ?
       ORDER BY as_of DESC
       LIMIT ?`
    )
    .all(field, capped) as Array<{
    as_of: string;
    filled_count: number;
    total_symbols: number;
    fill_rate: number;
    most_frequent_source: string | null;
  }>;
  return rows.map((row) => ({
    asOf: row.as_of,
    filledCount: row.filled_count,
    totalSymbols: row.total_symbols,
    fillRate: row.fill_rate,
    mostFrequentSource: row.most_frequent_source
  }));
}

/** Test helper — wipe durable coverage tables. */
export function __clearEnrichmentCoverageStoreForTests(): void {
  const database = getDb();
  database.exec(`DELETE FROM enrichment_coverage_fields; DELETE FROM enrichment_coverage_runs;`);
}
