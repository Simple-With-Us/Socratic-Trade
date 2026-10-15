/**
 * Nightly companyfacts sweep — polite EDGAR fetches off the market-scan critical path.
 * Cached JSON in `sec_facts` (`SEC_COMPANYFACTS_CACHE_CONCEPT`) is what SecXbrlEnrichmentProvider reads.
 */

import { deleteInternalSetting, getInternalSetting, setInternalSetting } from "../db-settings";
import { rankDemandFirstSymbols } from "../rag/demand-first-symbols";
import { loadTickerCikMap } from "./sec8k";
import { fetchAndCacheCompanyFacts } from "./sec-facts";
import { padCik } from "./sec-filings";
import { secUserAgent } from "./http";

const LAST_SWEEP_DATE_KEY = "sec_companyfacts_sweep_last_utc_date";
const SWEEP_CURSOR_KEY = "sec_companyfacts_sweep_cursor";
const SWEEP_FAILURE_MS_KEY = "sec_companyfacts_sweep_last_failure_ms";

const SWEEP_FAILURE_BACKOFF_MS = 60 * 60_000;
const DEFAULT_PER_TICK = 25;
const INTER_SYMBOL_DELAY_MS = 300;

function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function sweepPerTick(): number {
  const raw = Number(process.env.SEC_COMPANYFACTS_SWEEP_PER_TICK);
  return Number.isFinite(raw) && raw > 0 ? Math.min(200, Math.floor(raw)) : DEFAULT_PER_TICK;
}

/** True when the sweep has not finished for today's UTC date and is not in failure backoff. */
export function isSecCompanyFactsSweepDue(now: number): boolean {
  const lastComplete = getInternalSetting<string>(LAST_SWEEP_DATE_KEY);
  if (lastComplete === utcDate(now)) return false;
  const lastFailure = getInternalSetting<number>(SWEEP_FAILURE_MS_KEY);
  if (lastFailure && now - lastFailure < SWEEP_FAILURE_BACKOFF_MS) return false;
  return true;
}

export type SecCompanyFactsSweepSummary = {
  attempted: number;
  succeeded: number;
  skippedNoCik: number;
  cursor: number;
  total: number;
  completed: boolean;
};

/**
 * Advance the nightly companyfacts sweep by up to `SEC_COMPANYFACTS_SWEEP_PER_TICK` symbols.
 * Resumes from the stored cursor until the demand-first universe is covered, then marks the UTC day complete.
 */
export async function runSecCompanyFactsSweep(
  now: number = Date.now()
): Promise<SecCompanyFactsSweepSummary | null> {
  if (!isSecCompanyFactsSweepDue(now)) return null;

  const symbols = rankDemandFirstSymbols({ now });
  const tickerToCik = await loadTickerCikMap(now);
  let cursor = getInternalSetting<number>(SWEEP_CURSOR_KEY) ?? 0;
  if (cursor < 0 || cursor > symbols.length) cursor = 0;

  const batch = symbols.slice(cursor, cursor + sweepPerTick());
  if (batch.length === 0) {
    setInternalSetting(LAST_SWEEP_DATE_KEY, utcDate(now));
    setInternalSetting(SWEEP_CURSOR_KEY, 0);
    return { attempted: 0, succeeded: 0, skippedNoCik: 0, cursor: 0, total: symbols.length, completed: true };
  }

  // Touch user-agent resolution once so misconfiguration surfaces in sweep logs, not mid-batch.
  secUserAgent();

  let succeeded = 0;
  let skippedNoCik = 0;
  for (const symbol of batch) {
    const cik = tickerToCik[symbol];
    if (!cik) {
      skippedNoCik++;
      await delay(INTER_SYMBOL_DELAY_MS);
      continue;
    }
    try {
      await fetchAndCacheCompanyFacts(padCik(cik));
      succeeded++;
    } catch (err) {
      console.error(`[sec-companyfacts-sweep] ${symbol} CIK ${cik}:`, err instanceof Error ? err.message : err);
      setInternalSetting(SWEEP_FAILURE_MS_KEY, now);
      // Advance PAST the failing symbol.  Retrying the same cursor forever stalls every
      // later symbol when one CIK keeps throwing.  The 1h backoff still applies; the
      // skipped symbol is retried on the next full sweep after the cursor wraps.
      const nextCursor = cursor + batch.indexOf(symbol) + 1;
      setInternalSetting(SWEEP_CURSOR_KEY, nextCursor);
      return {
        attempted: batch.indexOf(symbol) + 1,
        succeeded,
        skippedNoCik,
        cursor: nextCursor,
        total: symbols.length,
        completed: false
      };
    }
    await delay(INTER_SYMBOL_DELAY_MS);
  }

  const nextCursor = cursor + batch.length;
  setInternalSetting(SWEEP_CURSOR_KEY, nextCursor);
  const completed = nextCursor >= symbols.length;
  if (completed) {
    setInternalSetting(LAST_SWEEP_DATE_KEY, utcDate(now));
    setInternalSetting(SWEEP_CURSOR_KEY, 0);
  }
  return {
    attempted: batch.length,
    succeeded,
    skippedNoCik,
    cursor: nextCursor,
    total: symbols.length,
    completed
  };
}

let sweepInFlight: Promise<SecCompanyFactsSweepSummary | null> | null = null;

/** Scheduler hook: resume the nightly sweep across ticks until the universe is cached. */
export async function runSecCompanyFactsSweepIfDue(
  now: number = Date.now()
): Promise<SecCompanyFactsSweepSummary | null> {
  if (!isSecCompanyFactsSweepDue(now)) return null;
  if (sweepInFlight) return sweepInFlight;
  sweepInFlight = runSecCompanyFactsSweep(now)
    .catch((err) => {
      console.error("[sec-companyfacts-sweep] sweep error:", err);
      setInternalSetting(SWEEP_FAILURE_MS_KEY, now);
      return null;
    })
    .finally(() => {
      sweepInFlight = null;
    });
  return sweepInFlight;
}

/** Test helper: reset sweep watermarks. */
export function resetSecCompanyFactsSweepStateForTests(): void {
  deleteInternalSetting(LAST_SWEEP_DATE_KEY);
  deleteInternalSetting(SWEEP_CURSOR_KEY);
  deleteInternalSetting(SWEEP_FAILURE_MS_KEY);
  sweepInFlight = null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
