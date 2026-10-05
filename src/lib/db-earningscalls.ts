// db-earningscalls.ts — CRUD for the EarningsCalls.dev fetch-once-forever transcript cache
// (schema in db.ts versioned migration 46; fetch/budget/selection policy lives in
// src/lib/earningscalls-transcripts.ts). Rows are GLOBAL shared market data (public-company
// earnings-call transcripts) — no user_id column, deliberately outside the per-user deletion
// sweep, same class as economic_events.
//
// Cache semantics (the reason this table exists — the provider plan is a HARD 200 requests/month):
//   - A row WITH `content` is immutable, fetched-once-forever: `upsertEarningsCallsTranscript`
//     refuses to overwrite non-null content with null, so a later negative/empty provider
//     response can never evict a real transcript, and callers must treat a content hit as
//     "never re-fetch".
//   - A row with `content` NULL is the NEGATIVE cache: a budget-costing call found the
//     transcript not yet available. `fetched_at` anchors the negative TTL.
//   - `ingested_at` tracks the separate downstream RAG-ingest step: content can be cached
//     (no more provider spend) while ingest retries later for free.
import "server-only";
import { getDb } from "./db";
import { normalizeSymbol } from "./money";

export interface EarningsCallsTranscriptRow {
  symbol: string;
  fiscalYear: number;
  fiscalQuarter: number;
  /** Provider earnings-call id (path key for /api/v1/transcripts/{earningsId}). */
  eventId?: number;
  /** Provider event_date_time — call-event metadata, not an availability timestamp. */
  eventDate?: string;
  /** Full transcript text. NULL/undefined = negative-cache row (not yet available upstream). */
  content?: string;
  fetchedAt: string;
  /** JSON blob of provider response metadata kept for provenance (never logged). */
  sourceMeta?: string;
  /** Set once the transcript reached the RAG corpus (storeDocument completed). */
  ingestedAt?: string;
}

interface RawRow {
  symbol: string;
  fiscal_year: number;
  fiscal_quarter: number;
  event_id: number | null;
  event_date: string | null;
  content: string | null;
  fetched_at: string;
  source_meta: string | null;
  ingested_at: string | null;
}

function toRow(raw: RawRow): EarningsCallsTranscriptRow {
  return {
    symbol: raw.symbol,
    fiscalYear: raw.fiscal_year,
    fiscalQuarter: raw.fiscal_quarter,
    eventId: raw.event_id ?? undefined,
    eventDate: raw.event_date ?? undefined,
    content: raw.content ?? undefined,
    fetchedAt: raw.fetched_at,
    sourceMeta: raw.source_meta ?? undefined,
    ingestedAt: raw.ingested_at ?? undefined
  };
}

export function getEarningsCallsTranscript(
  symbol: string,
  fiscalYear: number,
  fiscalQuarter: number
): EarningsCallsTranscriptRow | undefined {
  const raw = getDb()
    .prepare(
      `SELECT symbol, fiscal_year, fiscal_quarter, event_id, event_date, content, fetched_at, source_meta, ingested_at
       FROM earningscalls_transcripts WHERE symbol = ? AND fiscal_year = ? AND fiscal_quarter = ?`
    )
    .get(normalizeSymbol(symbol), fiscalYear, fiscalQuarter) as RawRow | undefined;
  return raw ? toRow(raw) : undefined;
}

/**
 * Insert or refresh one cache row. Content is fetch-once-forever: when the existing row already
 * has non-null content, an incoming null/empty content NEVER downgrades it back to a negative
 * row (COALESCE keeps the stored transcript), and `ingested_at` is preserved unless content
 * actually changed from empty to real (fresh content resets it so the ingest step runs).
 */
export function upsertEarningsCallsTranscript(row: Omit<EarningsCallsTranscriptRow, "ingestedAt">): void {
  getDb()
    .prepare(
      `INSERT INTO earningscalls_transcripts
         (symbol, fiscal_year, fiscal_quarter, event_id, event_date, content, fetched_at, source_meta, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(symbol, fiscal_year, fiscal_quarter) DO UPDATE SET
         event_id = COALESCE(excluded.event_id, earningscalls_transcripts.event_id),
         event_date = COALESCE(excluded.event_date, earningscalls_transcripts.event_date),
         content = COALESCE(earningscalls_transcripts.content, excluded.content),
         fetched_at = excluded.fetched_at,
         source_meta = COALESCE(excluded.source_meta, earningscalls_transcripts.source_meta),
         ingested_at = CASE
           WHEN earningscalls_transcripts.content IS NULL AND excluded.content IS NOT NULL THEN NULL
           ELSE earningscalls_transcripts.ingested_at
         END`
    )
    .run(
      normalizeSymbol(row.symbol),
      row.fiscalYear,
      row.fiscalQuarter,
      row.eventId ?? null,
      row.eventDate ?? null,
      row.content && row.content.trim() ? row.content : null,
      row.fetchedAt,
      row.sourceMeta ?? null
    );
}

export function markEarningsCallsTranscriptIngested(
  symbol: string,
  fiscalYear: number,
  fiscalQuarter: number,
  at: string = new Date().toISOString()
): void {
  getDb()
    .prepare(
      `UPDATE earningscalls_transcripts SET ingested_at = ?
       WHERE symbol = ? AND fiscal_year = ? AND fiscal_quarter = ?`
    )
    .run(at, normalizeSymbol(symbol), fiscalYear, fiscalQuarter);
}

/** Cached-but-not-yet-ingested transcripts (content present, ingest pending) — the free retry
 *  queue: re-running ingest costs zero provider requests. Oldest fetched first. */
export function listUningestedEarningsCallsTranscripts(limit = 5): EarningsCallsTranscriptRow[] {
  const rows = getDb()
    .prepare(
      `SELECT symbol, fiscal_year, fiscal_quarter, event_id, event_date, content, fetched_at, source_meta, ingested_at
       FROM earningscalls_transcripts
       WHERE content IS NOT NULL AND ingested_at IS NULL
       ORDER BY fetched_at ASC LIMIT ?`
    )
    .all(limit) as RawRow[];
  return rows.map(toRow);
}

// ── Per-symbol latest-call probe watermark ─────────────────────────────────────
// A latest-call probe costs one real budget request. This watermark bounds how often the same
// symbol can be probed (the negative TTL), independent of whether the probe found anything.

export interface EarningsCallsSymbolCheck {
  symbol: string;
  checkedAt: string;
  latestEventId?: number;
  latestEventDate?: string;
}

export function getEarningsCallsSymbolCheck(symbol: string): EarningsCallsSymbolCheck | undefined {
  const raw = getDb()
    .prepare(
      `SELECT symbol, checked_at, latest_event_id, latest_event_date
       FROM earningscalls_symbol_checks WHERE symbol = ?`
    )
    .get(normalizeSymbol(symbol)) as
    | { symbol: string; checked_at: string; latest_event_id: number | null; latest_event_date: string | null }
    | undefined;
  if (!raw) return undefined;
  return {
    symbol: raw.symbol,
    checkedAt: raw.checked_at,
    latestEventId: raw.latest_event_id ?? undefined,
    latestEventDate: raw.latest_event_date ?? undefined
  };
}

export function recordEarningsCallsSymbolCheck(check: EarningsCallsSymbolCheck): void {
  getDb()
    .prepare(
      `INSERT INTO earningscalls_symbol_checks (symbol, checked_at, latest_event_id, latest_event_date)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET
         checked_at = excluded.checked_at,
         latest_event_id = COALESCE(excluded.latest_event_id, earningscalls_symbol_checks.latest_event_id),
         latest_event_date = COALESCE(excluded.latest_event_date, earningscalls_symbol_checks.latest_event_date)`
    )
    .run(normalizeSymbol(check.symbol), check.checkedAt, check.latestEventId ?? null, check.latestEventDate ?? null);
}

// ── (symbol, fiscal_year, fiscal_quarter) -> provider earnings-call id map ─────────────────
// Populated by the id-resolution engine (the /transcripts/recent daily listing pages, and the
// /companies/ticker/{t} full-history resolver for targeted historical backfill). A row here means
// "the provider told us this call's id exists" — independent of whether a transcript was ever
// fetched for it (that's earningscalls_transcripts). See migration 53 (earningscalls_event_index)
// in db.ts for why this is a separate table from the transcripts cache.

export type EarningsCallsEventIndexSource = "listing" | "company-history" | "probe";

export interface EarningsCallsEventIndexRow {
  symbol: string;
  fiscalYear: number;
  fiscalQuarter: number;
  eventId: number;
  eventDate?: string;
  source: EarningsCallsEventIndexSource;
  discoveredAt: string;
}

interface RawEventIndexRow {
  symbol: string;
  fiscal_year: number;
  fiscal_quarter: number;
  event_id: number;
  event_date: string | null;
  source: string;
  discovered_at: string;
}

function toEventIndexRow(raw: RawEventIndexRow): EarningsCallsEventIndexRow {
  return {
    symbol: raw.symbol,
    fiscalYear: raw.fiscal_year,
    fiscalQuarter: raw.fiscal_quarter,
    eventId: raw.event_id,
    eventDate: raw.event_date ?? undefined,
    source: raw.source as EarningsCallsEventIndexSource,
    discoveredAt: raw.discovered_at
  };
}

/** Insert or refresh one (symbol, fy, fq) -> eventId mapping. Idempotent (safe to re-run the
 *  same listing page or history fetch); a later, more-specific source never downgrades the
 *  event_date once known. */
export function upsertEarningsCallsEventIndex(row: Omit<EarningsCallsEventIndexRow, "discoveredAt"> & { discoveredAt?: string }): void {
  const discoveredAt = row.discoveredAt ?? new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO earningscalls_event_index
         (symbol, fiscal_year, fiscal_quarter, event_id, event_date, source, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, fiscal_year, fiscal_quarter) DO UPDATE SET
         event_id = excluded.event_id,
         event_date = COALESCE(excluded.event_date, earningscalls_event_index.event_date),
         source = excluded.source,
         discovered_at = excluded.discovered_at`
    )
    .run(
      normalizeSymbol(row.symbol),
      row.fiscalYear,
      row.fiscalQuarter,
      row.eventId,
      row.eventDate ?? null,
      row.source,
      discoveredAt
    );
}

export function getEarningsCallsEventIndex(
  symbol: string,
  fiscalYear: number,
  fiscalQuarter: number
): EarningsCallsEventIndexRow | undefined {
  const raw = getDb()
    .prepare(
      `SELECT symbol, fiscal_year, fiscal_quarter, event_id, event_date, source, discovered_at
       FROM earningscalls_event_index WHERE symbol = ? AND fiscal_year = ? AND fiscal_quarter = ?`
    )
    .get(normalizeSymbol(symbol), fiscalYear, fiscalQuarter) as RawEventIndexRow | undefined;
  return raw ? toEventIndexRow(raw) : undefined;
}

/** Most recent known call for a symbol (highest fiscal_year, then fiscal_quarter) — the free
 *  (no-request) lookup the smart picker tries before falling back to a live per-symbol probe. */
export function getLatestEarningsCallsEventForSymbol(symbol: string): EarningsCallsEventIndexRow | undefined {
  const raw = getDb()
    .prepare(
      `SELECT symbol, fiscal_year, fiscal_quarter, event_id, event_date, source, discovered_at
       FROM earningscalls_event_index WHERE symbol = ?
       ORDER BY fiscal_year DESC, fiscal_quarter DESC LIMIT 1`
    )
    .get(normalizeSymbol(symbol)) as RawEventIndexRow | undefined;
  return raw ? toEventIndexRow(raw) : undefined;
}

/** True when the event index holds at least one row for the symbol (any period) — the "lacking
 *  coverage" test the burst's targeted-historical step uses to decide whether a held symbol is
 *  worth a /companies/ticker/{t} full-history call. */
export function hasAnyEarningsCallsEventForSymbol(symbol: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 AS present FROM earningscalls_event_index WHERE symbol = ? LIMIT 1`)
    .get(normalizeSymbol(symbol)) as { present: number } | undefined;
  return row !== undefined;
}

const CONTENT_SELECT =
  `SELECT symbol, fiscal_year, fiscal_quarter, event_id, event_date, content, fetched_at, source_meta, ingested_at
   FROM earningscalls_transcripts`;

/** Cached transcript rows for one symbol, newest fiscal period first. */
export function listEarningsCallsTranscriptsForSymbol(symbol: string): EarningsCallsTranscriptRow[] {
  const rows = getDb()
    .prepare(
      `${CONTENT_SELECT}
       WHERE symbol = ?
       ORDER BY fiscal_year DESC, fiscal_quarter DESC`
    )
    .all(normalizeSymbol(symbol)) as RawRow[];
  return rows.map(toRow);
}

export interface EarningsCallsCoverageBucket {
  symbol: string;
  count: number;
}

export interface EarningsCallsTranscriptCoverage {
  transcriptsWithContent: number;
  symbolsWithContent: number;
  symbolsAtDepth: number;
  symbolsPartial: number;
  perSymbol: EarningsCallsCoverageBucket[];
}

/**
 * Local Individual-archive inventory: rows with non-null transcript text.
 *
 * Do not filter with `length(content)`.  SQLite reads every transcript body to
 * compute it, and GET /api/ops/snapshot runs this synchronously on the serving
 * thread.  The 2026-10-05 82s stall profile has that route, better-sqlite3
 * `prepare`, and the ROIC `YYYYQn.json` walk from the same snapshot on one busy
 * run.  Empty bodies are stored as NULL, so `content IS NOT NULL` is the
 * inventory without touching the blobs.
 */
export function summarizeEarningsCallsTranscriptCoverage(
  depth: number = 20
): EarningsCallsTranscriptCoverage {
  const cap = Math.max(1, Math.floor(depth));
  const rows = getDb()
    .prepare(
      `SELECT symbol, COUNT(*) AS count
       FROM earningscalls_transcripts
       WHERE content IS NOT NULL
       GROUP BY symbol
       ORDER BY count ASC, symbol ASC`
    )
    .all() as Array<{ symbol: string; count: number }>;
  let transcriptsWithContent = 0;
  let symbolsAtDepth = 0;
  let symbolsPartial = 0;
  const perSymbol: EarningsCallsCoverageBucket[] = [];
  for (const row of rows) {
    transcriptsWithContent += row.count;
    perSymbol.push({ symbol: row.symbol, count: row.count });
    if (row.count >= cap) symbolsAtDepth += 1;
    else symbolsPartial += 1;
  }
  return {
    transcriptsWithContent,
    symbolsWithContent: rows.length,
    symbolsAtDepth,
    symbolsPartial,
    perSymbol
  };
}
