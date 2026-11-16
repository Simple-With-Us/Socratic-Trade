// economic-calendar.ts — forward economic-event awareness for the strategist (handoff 3.5).
//
// The strategist previously saw macro LEVELS (CPI value, fed funds, regime label) but nothing
// that says "CPI / FOMC / NFP is TOMORROW". This module ingests an injected economic-calendar
// fetcher at most ONCE PER UTC DAY (persisted watermark), keeps only
// high-impact US events over a short forward horizon in the small `economic_events` table
// (db.ts migration 42; CRUD in db-economic-events.ts), and exposes a compact upcoming-events
// read for the prompt.
//
// Operating rules (product philosophy — advisory, fail-open, quota-friendly):
//   - Source-gated: no production calendar source is wired (FMP is never used here), so
//     refresh is a no-op unless a fetcher is injected.  Existing economic_events rows stay
//     readable for the prompt.
//   - Ingest failure NEVER blocks a strategy run — it logs + audits and the prompt block is
//     simply omitted. A transport failure does not consume the daily watermark (retry after a
//     short in-process cool-off); a completed-but-empty fetch DOES (retrying an empty or
//     plan-restricted endpoint all day would just burn quota).
//   - Data is real or absent: no placeholder events, never an empty scaffold in the prompt.

import { audit, getInternalSetting, setInternalSetting } from "./db";
import { listUpcomingEconomicEvents, pruneEconomicEvents, upsertEconomicEvents, type EconomicEventRow } from "./db-economic-events";

export interface EconomicCalendar {
  date: string;
  country: string;
  event: string;
  currency: string;
  previous: number | null;
  estimate: number | null;
  actual: number | null;
  change: number | null;
  impact: string;
}

const WATERMARK_KEY = "economicCalendar:lastIngestDay";
/** Forward horizon injected into the prompt: next ~5 calendar days. */
export const ECONOMIC_CALENDAR_HORIZON_DAYS = 5;
/** Hard cap on prompt lines — a handful max. */
export const MAX_PROMPT_ECONOMIC_EVENTS = 6;
/** In-process cool-off after a thrown ingest failure (avoid hammering a broken endpoint per run). */
const FAILURE_RETRY_MS = 30 * 60_000;

let lastFailedAttemptMs = 0;

/** Test hook: clear the in-process failure cool-off. */
export function __resetEconomicCalendarStateForTests(): void {
  lastFailedAttemptMs = 0;
}

export interface UpcomingEconomicEvent {
  event: string;
  /** Calendar timestamp as stored (date or datetime). */
  date: string;
  impact?: string;
  estimate?: number | null;
  previous?: number | null;
  /** Honest same-day timing annotation: set when the event already printed (still inside the
   * short post-release grace window) or when a date-only row today may already have printed.
   * Absent for genuinely upcoming events. A past print must never be presented as upcoming. */
  timingNote?: string;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function utcDayPlus(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function isHighImpactUs(row: EconomicCalendar): boolean {
  const country = (row.country ?? "").trim().toUpperCase();
  const impact = (row.impact ?? "").trim().toLowerCase();
  return (country === "US" || country === "USA" || country === "UNITED STATES") && impact === "high";
}

function toEventRow(row: EconomicCalendar): EconomicEventRow | undefined {
  const event = typeof row.event === "string" ? row.event.trim() : "";
  const date = typeof row.date === "string" ? row.date.trim() : "";
  if (!event || !date) return undefined;
  return {
    id: `${date}|${event.toLowerCase()}`,
    event,
    eventDate: date,
    country: (row.country ?? "US").trim().toUpperCase(),
    impact: typeof row.impact === "string" && row.impact.trim() ? row.impact.trim() : undefined,
    estimate: typeof row.estimate === "number" && Number.isFinite(row.estimate) ? row.estimate : null,
    previous: typeof row.previous === "number" && Number.isFinite(row.previous) ? row.previous : null
  };
}

/** Grace window after a TIMESTAMPED event passes during which it is still returned — labeled as
 * released, never as upcoming — so the strategist sees "a print just hit" instead of silence.
 * Beyond it the event is excluded entirely (a stale print is not a catalyst). */
export const ECONOMIC_EVENT_RELEASED_GRACE_MS = 2 * 60 * 60_000;

/** Parse the stored calendar timestamp when it carries a time component. Stored calendar rows are
 * "YYYY-MM-DD HH:MM:SS" UTC datetimes (stored verbatim by toEventRow); a bare datetime is treated
 * as UTC, an explicit offset/Z is honored, and a date-only row returns undefined (time genuinely
 * unknown — the caller must not pretend otherwise). */
function eventTimestampUtcMs(eventDate: string): number | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?/.exec(eventDate);
  if (!match) return undefined;
  if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(eventDate)) {
    const explicit = Date.parse(eventDate);
    return Number.isFinite(explicit) ? explicit : undefined;
  }
  const parsed = Date.parse(`${match[1]}T${match[2]}${match[3] ?? ":00"}Z`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Refresh the economic_events cache if today's UTC ingest hasn't happened yet.
 * At most one upstream fetch per UTC day (persisted watermark). Fail-open: returns false
 * (and audits) on any failure; never throws. `fetchCalendar` is injectable; without one
 * there is no source, so this returns false.
 */
export async function refreshEconomicCalendarIfStale(
  now: Date = new Date(),
  userId?: string,
  fetchCalendar?: (from: string, to: string) => Promise<EconomicCalendar[]>
): Promise<boolean> {
  if (!fetchCalendar) return false;
  const day = utcDay(now);
  if (getInternalSetting<string>(WATERMARK_KEY) === day) return false; // daily watermark: no double-fetch
  if (Date.now() - lastFailedAttemptMs < FAILURE_RETRY_MS) return false; // recent failure cool-off
  try {
    const raw = await fetchCalendar(day, utcDayPlus(now, ECONOMIC_CALENDAR_HORIZON_DAYS));
    const rows = (Array.isArray(raw) ? raw : []).filter(isHighImpactUs).map(toEventRow).filter((row): row is EconomicEventRow => row !== undefined);
    upsertEconomicEvents(rows, now.toISOString());
    pruneEconomicEvents(day); // rolling cache: drop past events
    setInternalSetting(WATERMARK_KEY, day);
    audit("economic_calendar_ingest", { day, fetched: Array.isArray(raw) ? raw.length : 0, keptHighImpactUs: rows.length }, userId ?? "local");
    return true;
  } catch (error) {
    // Fail-open: an ingest failure means "no forward-events block this run", never a blocked run.
    lastFailedAttemptMs = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[economic-calendar] ingest failed (fail-open, retry after cool-off): ${message}`);
    try {
      audit("economic_calendar_ingest_failed", { day, error: message }, userId ?? "local");
    } catch {
      /* auditing must not turn fail-open into fail-closed */
    }
    return false;
  }
}

/** Upcoming high-impact US events within the forward horizon, soonest first, capped for the prompt.
 *
 * Same-day honesty (a past print must NEVER be presented as an upcoming catalyst):
 *  - Timestamped rows (the stored "YYYY-MM-DD HH:MM:SS" UTC shape) whose time has passed are
 *    EXCLUDED once past the short grace window; inside the window they are kept but labeled as
 *    released today, not upcoming.
 *  - Date-only rows for today carry a "may have already printed" annotation — the stored data
 *    genuinely has no intraday time, so the model is told about the ambiguity instead of misled. */
export function getUpcomingEconomicEvents(now: Date = new Date(), horizonDays: number = ECONOMIC_CALENDAR_HORIZON_DAYS, limit: number = MAX_PROMPT_ECONOMIC_EVENTS): UpcomingEconomicEvent[] {
  // Over-fetch: same-day rows that already printed are dropped below, so the SQL limit alone
  // could under-fill the prompt cap while genuinely upcoming rows exist further out.
  const rows = listUpcomingEconomicEvents(utcDay(now), utcDayPlus(now, horizonDays + 1), limit + 24);
  const nowMs = now.getTime();
  const today = utcDay(now);
  const events: UpcomingEconomicEvent[] = [];
  for (const row of rows) {
    if (events.length >= limit) break;
    const base: UpcomingEconomicEvent = {
      event: row.event,
      date: row.eventDate,
      impact: row.impact,
      estimate: row.estimate,
      previous: row.previous
    };
    const releaseMs = eventTimestampUtcMs(row.eventDate);
    if (releaseMs !== undefined) {
      if (nowMs >= releaseMs + ECONOMIC_EVENT_RELEASED_GRACE_MS) continue; // already printed — stale, drop
      if (nowMs >= releaseMs) {
        events.push({ ...base, timingNote: "released earlier today — this print is already public; treat it as fresh news, NOT an upcoming catalyst" });
        continue;
      }
      events.push(base);
    } else {
      events.push(row.eventDate === today ? { ...base, timingNote: "scheduled today, release time unknown — it may have already printed" } : base);
    }
  }
  return events;
}

/**
 * One-call prompt path: opportunistically refresh (daily-watermarked, fail-open), then read.
 * Always resolves — an empty array means the prompt block is OMITTED entirely.
 */
export async function getUpcomingEconomicEventsForPrompt(userId?: string, now: Date = new Date()): Promise<UpcomingEconomicEvent[]> {
  await refreshEconomicCalendarIfStale(now, userId).catch(() => false);
  try {
    return getUpcomingEconomicEvents(now);
  } catch {
    return [];
  }
}
