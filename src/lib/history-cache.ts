import { getDb } from "./db";
import type { OHLCBar } from "./indicators";
import { normalizeSymbol } from "./money";

/**
 * Upsert daily bars keyed by (ticker, date). Rows are permanent: nothing here
 * deletes by age. A later read can serve a multi-year series without refetching
 * the prefix. Callers still decide whether a fresh series is long enough.
 */
export function upsertHistoryCacheEod(rawSymbol: string, bars: OHLCBar[]): void {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol || !bars || bars.length === 0) return;

  const nowStr = new Date().toISOString();
  
  const db = getDb();
  // source + updated_at = provenance (which tier wrote the bar + when we stored it).
  // Migration v70 added `source`; fall back gracefully if a very old test DB lacks the column.
  const insert = db.prepare(`
    INSERT INTO history_cache_eod (ticker, date, open, high, low, close, volume, vwap, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, date) DO UPDATE SET
      open       = COALESCE(excluded.open, history_cache_eod.open),
      high       = COALESCE(excluded.high, history_cache_eod.high),
      low        = COALESCE(excluded.low, history_cache_eod.low),
      close      = excluded.close,
      volume     = COALESCE(excluded.volume, history_cache_eod.volume),
      vwap       = COALESCE(excluded.vwap, history_cache_eod.vwap),
      source     = COALESCE(excluded.source, history_cache_eod.source),
      updated_at = excluded.updated_at
  `);

  const tx = db.transaction((txBars: OHLCBar[]) => {
    for (const b of txBars) {
      if (typeof b.close !== "number" || !Number.isFinite(b.close)) continue;
      
      let dateStr = "";
      if (typeof b.time === "string") {
        dateStr = b.time.slice(0, 10);
      } else if (typeof b.time === "number") {
        const ms = b.time < 1e10 ? b.time * 1000 : b.time;
        dateStr = new Date(ms).toISOString().slice(0, 10);
      } else {
        continue; // Invalid time
      }

      insert.run(
        symbol,
        dateStr,
        b.open ?? null,
        b.high ?? null,
        b.low ?? null,
        b.close,
        b.volume ?? null,
        b.vwap ?? null,
        b.source ?? "unknown",
        b.fetchedAt ?? nowStr
      );
    }
  });

  try {
    tx(bars);
  } catch (err) {
    console.error(`[history-cache] Failed to upsert SQLite EOD cache for ${symbol}:`, err);
  }
}

export function fetchHistoryCacheEod(rawSymbol: string): OHLCBar[] | null {
  if (process.env.MASSIVE_LOCAL_HISTORY_ENABLED === "off") return null;
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) return null;
  if (process.env.NODE_ENV === "test" && process.env.MASSIVE_LOCAL_HISTORY_ENABLED !== "on" && symbol !== "TESTSYM") return null;

  try {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT date, open, high, low, close, volume, vwap, source, updated_at
      FROM history_cache_eod 
      WHERE ticker = ? 
      ORDER BY date ASC
    `);
    const rows = stmt.all(symbol) as {
      date: string;
      open: number | null;
      high: number | null;
      low: number | null;
      close: number;
      volume: number | null;
      vwap: number | null;
      source?: string | null;
      updated_at?: string | null;
    }[];

    if (!rows || rows.length < 2) return null;

    const bars: OHLCBar[] = [];
    for (const r of rows) {
      bars.push({
        time: r.date,
        open: r.open ?? undefined,
        high: r.high ?? undefined,
        low: r.low ?? undefined,
        close: r.close,
        volume: r.volume ?? undefined,
        vwap: r.vwap ?? undefined,
        source: r.source?.trim() || "history-cache-eod",
        fetchedAt: r.updated_at ?? undefined
      });
    }

    return bars;
  } catch (err) {
    console.error(`[history-cache] Failed to fetch SQLite EOD cache for ${symbol}:`, err);
    return null;
  }
}
