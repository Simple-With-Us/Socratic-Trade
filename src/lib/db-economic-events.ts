// db-economic-events.ts — CRUD for the economic_events cache (handoff 3.5: forward
// economic-event awareness). Schema lives in db.ts migrate() (versioned migration 42);
// ingest/refresh policy lives in src/lib/economic-calendar.ts. Rows are a small rolling
// cache of upcoming scheduled macro events (CPI/FOMC/NFP class) — shared market data,
// not per-user state.
import "server-only";
import { getDb } from "./db";

export interface EconomicEventRow {
  /** Stable dedupe key: `${eventDate}|${event}` (normalized). */
  id: string;
  event: string;
  /** Calendar timestamp for the release/meeting (e.g. "2026-07-16 08:30:00" or ISO). */
  eventDate: string;
  country: string;
  impact?: string;
  estimate?: number | null;
  previous?: number | null;
}

/** Insert-or-refresh a batch of calendar rows in one transaction. */
export function upsertEconomicEvents(rows: EconomicEventRow[], fetchedAt: string = new Date().toISOString()): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO economic_events (id, event, event_date, country, impact, estimate, previous, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       impact = excluded.impact,
       estimate = excluded.estimate,
       previous = excluded.previous,
       fetched_at = excluded.fetched_at`
  );
  const insertAll = db.transaction((batch: EconomicEventRow[]) => {
    for (const row of batch) {
      stmt.run(row.id, row.event, row.eventDate, row.country, row.impact ?? null, row.estimate ?? null, row.previous ?? null, fetchedAt);
    }
  });
  insertAll(rows);
}

/** Upcoming events in [fromDate, toDateExclusive), soonest first. Bounds are date or datetime
 *  strings in the same format family the rows were stored with (ISO-ordered, so plain string
 *  comparison is chronological — pass the day AFTER the horizon as the exclusive upper bound so
 *  intraday timestamps on the last day are included). */
export function listUpcomingEconomicEvents(fromDate: string, toDateExclusive: string, limit = 12): EconomicEventRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, event, event_date, country, impact, estimate, previous
       FROM economic_events
       WHERE event_date >= ? AND event_date < ?
       ORDER BY event_date ASC, event ASC
       LIMIT ?`
    )
    .all(fromDate, toDateExclusive, limit) as Array<{
    id: string;
    event: string;
    event_date: string;
    country: string;
    impact: string | null;
    estimate: number | null;
    previous: number | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    event: row.event,
    eventDate: row.event_date,
    country: row.country,
    impact: row.impact ?? undefined,
    estimate: row.estimate,
    previous: row.previous
  }));
}

/** Jay policy (2026-10-15): economic calendar rows are kept forever. */
export function pruneEconomicEvents(_beforeDate: string): number {
  return 0;
}
