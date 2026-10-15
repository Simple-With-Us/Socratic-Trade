/**
 * Durable market-field store.
 *
 * Three layers:
 * 1. `historical_fundamentals` — append-only numeric PIT history (existing). Its `effective_at`
 *    is ambiguous (poll time vs. the fact's true reporting date is not distinguished, there is no
 *    `form`/restatement column, and it has never had a reader — see the file's write-only history).
 *    Deliberately NOT retrofitted into a revision chain: bolting `form`/supersession semantics onto
 *    a row shape that was never designed for them risks silently changing meaning for whatever future
 *    caller finally reads it. `fundamental_revisions` below is the clean-slate replacement for the
 *    fields that need real point-in-time correctness.
 * 2. `symbol_field_latest` — latest known value for EVERY field on EVERY symbol ever seen, each row
 *    carrying its own `as_of` and `fetched_at` timestamps.
 * 3. `fundamental_revisions` — the point-in-time REVISION CHAIN for SEC-XBRL-derived GAAP facts
 *    (today: `debtToEquity`, `revenueGrowth`; future EPS/revenue fields can reuse the same shape).
 *    Mirrors the `sec_filings`/`learned_context` `superseded_by` idiom: a later filing for the same
 *    (symbol, field, fiscal_period_end) marks the prior LIVE row's `superseded_by` instead of
 *    overwriting it, so a restated value never erases what the app actually knew before the
 *    restatement. See `recordFundamentalRevision` / `getFundamentalAsOf` below.
 *
 * The latest store is SHARED (no user_id): public market data (PE, sector,
 * volume, headlines, …) is not account-private. Symbols that leave the
 * universe or a given day's scan keep their last known fields forever until a
 * newer observation overwrites them field-by-field. `fundamental_revisions` is
 * GLOBAL market data for the same reason (SEC filings are public-company
 * facts, not account-private) — deliberately exempt from
 * DELETE_TABLES_BY_USER_ID, same class as `sec_filings`/`symbol_field_latest`.
 *
 * Strategy-run audits deliberately strip the full MarketScan for size; this
 * table is the durable recovery path so interactive scans, other users, and
 * later strategy runs can still read the most recent per-field data.
 *
 * PIT SAFETY CONTRACT: `getFundamentalAsOf` is the ONLY reader in this module safe to use when
 * evaluating a HISTORICAL decision (a backtest, a lookahead audit, a replay — anything asking "what
 * did we know as of date X"). `getSymbolFieldLatest`, `getSymbolFieldLatestBySymbol`,
 * `getSymbolLatestPrices`, and `marketQuoteSummariesFromFieldStore` all answer "what do we know RIGHT
 * NOW" — feeding any of them into a historical-decision evaluation leaks the future (a later
 * restatement, or simply a newer scan's overwrite, would silently apply to an old decision date).
 * Only `debtToEquity`/`revenueGrowth` have a revision chain today; every other field still has NO
 * point-in-time-safe reader — that gap is real and must be surfaced honestly, not papered over by
 * reaching for the latest-value store.
 */

import "server-only";
import { getDb } from "./db";
import type { Database } from "better-sqlite3";
import { normalizeSymbol } from "./money";
import { envFlagOn } from "./rag/env-flag";

export interface HistoricalFundamentalRecord {
  symbol: string;
  field: string;
  value: number;
  provider: string;
  effectiveAt: string;
  fetchedAt: string;
}

/** One field's latest observation — timestamps are ALWAYS per-field, never scan-level. */
export interface SymbolFieldLatestRecord {
  symbol: string;
  field: string;
  /** JSON-encoded value (number | string | boolean | array | object). */
  valueJson: string;
  source: string;
  /** When the market fact was true / observed upstream (ISO). May equal fetchedAt. */
  asOf: string;
  /** When WE stored/received this value (ISO). */
  fetchedAt: string;
}

export function recordHistoricalFundamentals(
  records: HistoricalFundamentalRecord[],
  database: Database = getDb()
): void {
  if (records.length === 0) return;

  const stmt = database.prepare(`
    INSERT OR IGNORE INTO historical_fundamentals (symbol, field, value, provider, effective_at, fetched_at)
    VALUES (@symbol, @field, @value, @provider, @effectiveAt, @fetchedAt)
  `);

  const insertMany = database.transaction((recs: HistoricalFundamentalRecord[]) => {
    for (const rec of recs) {
      stmt.run(rec);
    }
  });

  insertMany(records);
}

// ── fundamental_revisions: point-in-time revision chain (SEC-XBRL GAAP facts) ─────────────────

/**
 * One SEC-XBRL point-in-time fact for a derived field, before it is attributed to a symbol/
 * provider (see `FundamentalRevisionRecord` for the full writer input). Produced by
 * `parseCompanyFacts` in data-providers.ts and threaded through `SymbolEnrichment.revisions` so
 * `CascadingEnrichmentProvider.enrich`'s SEC-XBRL branch can persist the raw revision chain, not
 * just the winning scalar it publishes to `symbol_field_latest`.
 */
export interface FundamentalRevisionFact {
  field: string;
  fiscalPeriodEnd: string;
  value: number;
  /** SEC form that carried this fact (e.g. "10-K", "10-K/A", "10-Q", "10-Q/A"). */
  form: string;
  /** SEC EDGAR `filed` date (YYYY-MM-DD) — when this specific fact became known, NOT the
   *  fiscal period it describes. This is the timestamp `getFundamentalAsOf` filters on. */
  filedAt: string;
}

export interface FundamentalRevisionRecord extends FundamentalRevisionFact {
  symbol: string;
  provider: string;
}

/**
 * Record one point-in-time revision fact. Mirrors the `sec_filings`/`learned_context`
 * `superseded_by` idiom: inserting a NEW revision for the same (symbol, field,
 * fiscal_period_end) marks every currently-LIVE prior row in that group `superseded_by` the new
 * row's own `filed_at` — there is no synthetic id, and symbol/field/fiscal_period_end are already
 * fixed within the group, so the successor's `filed_at` alone is enough to look it back up. The
 * superseded row is NEVER deleted or overwritten — it stays queryable for anyone auditing what the
 * app knew before the restatement. `superseded_by` is a pure audit annotation: `getFundamentalAsOf`
 * does not filter on it, so a superseded row still participates correctly in AS-OF queries dated
 * before its successor's `filed_at`.
 *
 * Idempotent: re-recording the same (symbol, field, fiscal_period_end, filed_at) fact (e.g. a
 * later scan re-observing the same SEC filing) is a no-op — INSERT OR IGNORE on the composite PK.
 */
export function recordFundamentalRevision(
  record: FundamentalRevisionRecord,
  database: Database = getDb()
): void {
  const symbol = normalizeSymbol(record.symbol);
  const field = String(record.field ?? "").trim();
  const fiscalPeriodEnd = String(record.fiscalPeriodEnd ?? "").trim();
  const filedAt = String(record.filedAt ?? "").trim();
  const form = String(record.form ?? "").trim();
  const provider = String(record.provider ?? "").trim() || "unknown";
  if (!symbol || !field || !fiscalPeriodEnd || !filedAt || !form) return;
  if (typeof record.value !== "number" || !Number.isFinite(record.value)) return;

  const insert = database.prepare(`
    INSERT OR IGNORE INTO fundamental_revisions
      (symbol, field, fiscal_period_end, value, form, filed_at, provider, superseded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `);
  const groupFiledAts = database.prepare(`
    SELECT filed_at FROM fundamental_revisions
    WHERE symbol = ? AND field = ? AND fiscal_period_end = ?
    ORDER BY filed_at ASC
  `);
  const setSupersededBy = database.prepare(`
    UPDATE fundamental_revisions
    SET superseded_by = ?
    WHERE symbol = ? AND field = ? AND fiscal_period_end = ? AND filed_at = ?
  `);

  const run = database.transaction(() => {
    const result = insert.run(
      symbol,
      field,
      fiscalPeriodEnd,
      record.value,
      form,
      filedAt,
      provider,
      new Date().toISOString()
    );
    // Only re-chain when this row is genuinely new — a re-recorded (idempotent) fact must not
    // re-run the sweep (harmless either way, but pointless work).
    if (result.changes > 0) {
      // Recompute the whole (symbol, field, fiscal_period_end) chain by filed_at ascending rather
      // than only re-pointing predecessors of the new row: SEC companyfacts array order is not
      // contractual, so an earlier-filed revision can legitimately arrive AFTER a later-filed one
      // already exists. Re-pointing only "filed_at < new" leaves that out-of-order case with two
      // live (superseded_by NULL) rows — this full re-sort guarantees exactly the newest filed_at
      // row is ever live, independent of insertion order.
      const group = groupFiledAts.all(symbol, field, fiscalPeriodEnd) as Array<{ filed_at: string }>;
      for (let i = 0; i < group.length; i++) {
        const nextFiledAt = group[i + 1]?.filed_at ?? null;
        setSupersededBy.run(nextFiledAt, symbol, field, fiscalPeriodEnd, group[i]!.filed_at);
      }
    }
  });
  run();
}

/**
 * Opt-in strict as-of mode (mirrors `asOfStrictEnabled()` / VECTOR_ASOF_STRICT in vector-db.ts).
 * OFF by default — set FUNDAMENTALS_ASOF_STRICT=on to make `getFundamentalAsOf` fail closed
 * (return `undefined`) instead of falling back to `symbol_field_latest` when no revision row
 * covers the requested date. A per-call `options.strict` always overrides this default.
 */
export function fundamentalsAsOfStrictEnabled(): boolean {
  return envFlagOn("FUNDAMENTALS_ASOF_STRICT", false);
}

/**
 * Point-in-time read: the value of `field` for `symbol` AS KNOWN on `asOf` (ISO date/datetime,
 * compared lexicographically against `filed_at` — both are ISO-formatted so this is safe).
 * Picks the most recent fiscal period whose filing was known by `asOf`, then the most recent
 * filing within that period (a same-period restatement filed by `asOf` wins over the original).
 *
 * THIS is the PIT-safe reader — see the file header's PIT SAFETY CONTRACT. Do not substitute
 * `getSymbolFieldLatest`/`marketQuoteSummariesFromFieldStore` for a historical decision; they
 * answer "what do we know right now," not "what did we know as of `asOf`."
 *
 * - Lenient (default, `strict` omitted or false and FUNDAMENTALS_ASOF_STRICT unset/off): no
 *   revision row covers `asOf` -> falls back to `symbol_field_latest` (today's non-PIT behavior),
 *   so a field with no revision history yet (or not SEC-XBRL-derived at all) never blocks a live
 *   decision.
 * - Strict (`options.strict === true`, or FUNDAMENTALS_ASOF_STRICT=on and `options.strict` unset):
 *   no revision row covers `asOf` -> returns `undefined`. Never guesses.
 */
export function getFundamentalAsOf(
  symbol: string,
  field: string,
  asOf: string,
  options: { strict?: boolean } = {},
  database: Database = getDb()
): number | undefined {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol || !field || !asOf) return undefined;

  const row = database
    .prepare(
      `SELECT value FROM fundamental_revisions
       WHERE symbol = ? AND field = ? AND filed_at <= ?
       ORDER BY fiscal_period_end DESC, filed_at DESC
       LIMIT 1`
    )
    .get(normalizedSymbol, field, asOf) as { value: number } | undefined;
  if (row) return row.value;

  const strict = options.strict ?? fundamentalsAsOfStrictEnabled();
  if (strict) return undefined;

  const latest = getSymbolFieldLatest([normalizedSymbol], database).find((r) => r.field === field);
  return typeof latest?.value === "number" && Number.isFinite(latest.value) ? latest.value : undefined;
}

/**
 * Upsert latest field values. Only overwrites an existing row when the incoming
 * `fetched_at` is >= the stored one (never clobber a newer observation with an
 * older write). Empty/invalid records are skipped.
 */
export function upsertSymbolFieldLatest(
  records: SymbolFieldLatestRecord[],
  database: Database = getDb()
): number {
  if (records.length === 0) return 0;

  const stmt = database.prepare(`
    INSERT INTO symbol_field_latest (symbol, field, value_json, source, as_of, fetched_at)
    VALUES (@symbol, @field, @valueJson, @source, @asOf, @fetchedAt)
    ON CONFLICT(symbol, field) DO UPDATE SET
      value_json = excluded.value_json,
      source = excluded.source,
      as_of = excluded.as_of,
      fetched_at = excluded.fetched_at
    WHERE excluded.fetched_at >= symbol_field_latest.fetched_at
  `);

  let written = 0;
  const run = database.transaction((recs: SymbolFieldLatestRecord[]) => {
    for (const rec of recs) {
      const symbol = normalizeSymbol(rec.symbol);
      const field = String(rec.field ?? "").trim();
      if (!symbol || !field || !rec.valueJson) continue;
      const asOf = rec.asOf || rec.fetchedAt;
      const fetchedAt = rec.fetchedAt || asOf;
      if (!fetchedAt) continue;
      const result = stmt.run({
        symbol,
        field,
        valueJson: rec.valueJson,
        source: rec.source || "unknown",
        asOf,
        fetchedAt
      });
      written += result.changes;
    }
  });
  run(records);
  return written;
}

export interface SymbolFieldLatestRow {
  symbol: string;
  field: string;
  value: unknown;
  source: string;
  /** Per-field observation / market-truth time. */
  asOf: string;
  /** Per-field when we stored it. */
  fetchedAt: string;
}

/** Load every latest field row for the given symbols (any subset; missing = no rows). */
export function getSymbolFieldLatest(
  symbols: string[],
  database: Database = getDb()
): SymbolFieldLatestRow[] {
  const normalized = Array.from(
    new Set(symbols.map((s) => normalizeSymbol(s)).filter(Boolean))
  );
  if (normalized.length === 0) return [];

  const placeholders = normalized.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT symbol, field, value_json, source, as_of, fetched_at
       FROM symbol_field_latest
       WHERE symbol IN (${placeholders})`
    )
    .all(...normalized) as Array<{
    symbol: string;
    field: string;
    value_json: string;
    source: string;
    as_of: string;
    fetched_at: string;
  }>;

  const out: SymbolFieldLatestRow[] = [];
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.value_json);
    } catch {
      continue;
    }
    out.push({
      symbol: row.symbol,
      field: row.field,
      value,
      source: row.source,
      asOf: row.as_of,
      fetchedAt: row.fetched_at
    });
  }
  return out;
}

/** Latest durable price per symbol (field = "price" only — cheaper than loading
 *  every field via getSymbolFieldLatest). Used by the dashboard snapshot as the
 *  Orders screen's final "Last price" fallback; each entry keeps its own as_of
 *  so the UI can age-tag it. Non-finite / non-positive stored values are
 *  skipped — never surface a fabricated price. */
export function getSymbolLatestPrices(
  symbols: string[],
  database: Database = getDb()
): Record<string, { price: number; asOf: string; source: string }> {
  const normalized = Array.from(new Set(symbols.map((s) => normalizeSymbol(s)).filter(Boolean)));
  if (normalized.length === 0) return {};

  const placeholders = normalized.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT symbol, value_json, source, as_of
       FROM symbol_field_latest
       WHERE field = 'price' AND symbol IN (${placeholders})`
    )
    .all(...normalized) as Array<{ symbol: string; value_json: string; source: string; as_of: string }>;

  const out: Record<string, { price: number; asOf: string; source: string }> = {};
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.value_json);
    } catch {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    out[row.symbol] = { price: value, asOf: row.as_of, source: row.source };
  }
  return out;
}

/** Group latest rows by symbol → field → row (handy for seed builders). */
export function getSymbolFieldLatestBySymbol(
  symbols: string[],
  database: Database = getDb()
): Record<string, Record<string, SymbolFieldLatestRow>> {
  const grouped: Record<string, Record<string, SymbolFieldLatestRow>> = {};
  for (const row of getSymbolFieldLatest(symbols, database)) {
    const byField = grouped[row.symbol] ?? (grouped[row.symbol] = {});
    byField[row.field] = row;
  }
  return grouped;
}

/** Encode a JS value for value_json; returns null when the value should not be stored. */
export function encodeFieldValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (Array.isArray(value) && value.length === 0) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * Build latest-store records from a cascade-style enrichment map.
 * Prefer each field's FieldObservation timestamps when present; fall back to
 * `fallbackFetchedAt` so every stored field still carries per-field stamps.
 */
export function recordsFromEnrichmentMap(
  // Accept cascade SymbolEnrichment maps without forcing an index signature.
  merged: Record<string, object>,
  fallbackFetchedAt: string = new Date().toISOString()
): SymbolFieldLatestRecord[] {
  // analystBySource is intentionally NOT in META — persist as JSON for nightly congress-share counts.
  const META = new Set([
    "sources",
    "fieldObservations",
    "providerFailures",
    "fieldDates",
    "shortPercentOfFloatSecondary",
    "shortInterestDisagreement",
    // Raw PIT revision facts (see fundamental_revisions / recordFundamentalRevision) — persisted
    // separately by CascadingEnrichmentProvider.enrich's SEC-XBRL branch, never as a scalar field.
    "revisions"
  ]);
  const out: SymbolFieldLatestRecord[] = [];

  for (const [rawSymbol, enrichmentObj] of Object.entries(merged)) {
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol || !enrichmentObj) continue;
    const enrichment = enrichmentObj as Record<string, unknown>;

    const observations =
      (enrichment.fieldObservations as
        | Record<
            string,
            {
              value?: unknown;
              source?: string;
              asOf?: string;
              observedAt?: string;
              effectiveAt?: string;
              fetchedAt?: string;
            }
          >
        | undefined) ?? {};
    const sources = (enrichment.sources as Record<string, string> | undefined) ?? {};

    // Prefer explicit fieldObservations (they already carry per-field stamps).
    for (const [field, obs] of Object.entries(observations)) {
      if (!obs) continue;
      const value = obs.value !== undefined ? obs.value : enrichment[field];
      const valueJson = encodeFieldValue(value);
      if (!valueJson) continue;
      const asOf =
        obs.asOf ?? obs.observedAt ?? obs.effectiveAt ?? obs.fetchedAt ?? fallbackFetchedAt;
      const fetchedAt = obs.fetchedAt ?? fallbackFetchedAt;
      out.push({
        symbol,
        field,
        valueJson,
        source: obs.source ?? sources[field] ?? "unknown",
        asOf,
        fetchedAt
      });
    }

    // Also persist scalar/array keys that have values but no observation receipt
    // (e.g. headlines, analystRating after blend, provider-only fields).
    for (const [field, value] of Object.entries(enrichment)) {
      if (META.has(field)) continue;
      if (observations[field]) continue; // already handled
      const valueJson = encodeFieldValue(value);
      if (!valueJson) continue;
      const fieldDate = (enrichment.fieldDates as Record<string, string> | undefined)?.[field];
      out.push({
        symbol,
        field,
        valueJson,
        source: sources[field] ?? "unknown",
        asOf: fieldDate ?? fallbackFetchedAt,
        fetchedAt: fallbackFetchedAt
      });
    }
  }
  return out;
}

/**
 * Build seed-shaped quote summaries from the latest store for interactive/strategy
 * reuse. Each field keeps its own asOf/fetchedAt inside fieldObservations so the
 * UI can show per-cell age, not a single scan clock.
 */
export function marketQuoteSummariesFromFieldStore(
  symbols: string[],
  database: Database = getDb()
): Record<
  string,
  {
    symbol: string;
    price: number;
    score: number;
    sources?: Record<string, string>;
    fieldObservations?: Record<
      string,
      { value?: unknown; source: string; asOf?: string; fetchedAt?: string; status: "ok" }
    >;
    [key: string]: unknown;
  }
> {
  const bySymbol = getSymbolFieldLatestBySymbol(symbols, database);
  const out: ReturnType<typeof marketQuoteSummariesFromFieldStore> = {};

  for (const [symbol, fields] of Object.entries(bySymbol)) {
    const sources: Record<string, string> = {};
    const fieldObservations: NonNullable<
      (typeof out)[string]["fieldObservations"]
    > = {};
    const quote: (typeof out)[string] = {
      symbol,
      price: 0,
      score: 0,
      sources,
      fieldObservations
    };

    for (const [field, row] of Object.entries(fields)) {
      (quote as Record<string, unknown>)[field] = row.value;
      if (row.source) sources[field] = row.source;
      fieldObservations[field] = {
        value: row.value,
        source: row.source,
        asOf: row.asOf,
        fetchedAt: row.fetchedAt,
        status: "ok"
      };
    }

    // Seed validation in marketScanQuotesFromAudit requires finite price + score.
    // Use stored price when present; otherwise a sentinel 0 that applyEnrichment will
    // ignore for price-family (needs > 0) while still carrying slow fields.
    if (typeof quote.price !== "number" || !Number.isFinite(quote.price)) {
      quote.price = 0;
    }
    if (typeof quote.score !== "number" || !Number.isFinite(quote.score)) {
      quote.score = 0;
    }
    out[symbol] = quote;
  }
  return out;
}
