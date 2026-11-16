// Monthly Pinecone write-unit (WU) PACE guard — the post-trial companion to
// pinecone-wu-breaker.ts.
//
// Why this exists (owner directive 2026-08-09): the owner opened a Pinecone STANDARD trial to
// index as much high-value corpus as possible, then intends to drop back to a free/$20 plan.
// The existing breaker (pinecone-wu-breaker.ts) is REACTIVE — it only trips once Pinecone has
// already answered 429 "write unit limit for the current month". That is the wall we hit in
// August 2026 and it costs a whole month of ingest. This module is the PROACTIVE half: it
// tracks write units consumed in the current CALENDAR month, projects month-end usage linearly
// (same pace concept as r2-usage.ts's free-tier monitor), and throttles NEW BULK BACKFILL work
// before the quota is actually exhausted.
//
// Scope discipline (owner philosophy — advisory guardrails, never a cage):
//   - Throttles the BULK/BACKFILL lane ONLY (the durable SEC ingest worker queue). Small
//     incremental daily-filing ingest and ALL retrieval stay completely un-gated — a paced
//     month must degrade to "the backfill waits" and never to "the app stops answering".
//   - DEFAULT OFF: PINECONE_MONTHLY_WU_BUDGET defaults to 0, which disables the throttle
//     entirely. Nothing changes until the owner sets a budget matching the plan they land on.
//   - One advisory per calendar month, not one per tick.
//   - The owner can clear the state at any time by deleting two internal-settings rows.
//
// The month-to-date counter accumulates EVEN WHEN THE BUDGET IS OFF, on purpose: it is the
// number that tells the owner how many WUs the trial actually burned, which is exactly the
// input needed to choose the post-trial plan. Counting is one settings UPSERT per successful
// Pinecone upsert batch (the same call site that already writes a rag_usage row).
//
// Relationship to RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY: that fuse is a rolling-24h volume cap
// computed from the rag_usage ledger and it hard-skips documents inside storeContexts. This is a
// CALENDAR-MONTH pace projection with a persisted counter (survives rag_usage pruning) that only
// pauses the backfill queue. They are complementary: the daily fuse bounds a burst, the monthly
// pace bounds the trend.
//
// WEBPACK TRAP: reachable from scheduler.ts (via rag-metering.ts -> vector-db.ts) — do not
// import "os" and do not use "node:"-prefixed import specifiers in this module.

import { audit, getInternalSetting, setInternalSetting } from "./db";
import { alertStorageWarning } from "./db-health";
import { isPineconeTrialActive, pineconeTrialState } from "./pinecone-trial-window";

/** Internal-settings key holding `{ month: "YYYY-MM", units, updatedAt }` for the current month. */
export const PINECONE_MONTH_WU_KEY = "pinecone:monthWriteUnits";
/** Internal-settings key holding the "YYYY-MM" whose pace advisory has already been sent. */
export const PINECONE_MONTH_PACE_ADVISED_KEY = "pinecone:monthWuPaceAdvisedMonth";

/**
 * Floor for the month-elapsed fraction used in the projection. Copied from r2-usage.ts's
 * R2_OPS_PACE_ELAPSED_FLOOR and for the same reason: without it, a burst on the 1st (0.5%
 * elapsed) projects to 200x and false-fires. 0.2 caps the multiplier at 5x — still catches a
 * genuine runaway backfill, tames month-start noise.
 */
export const PINECONE_PACE_ELAPSED_FLOOR = 0.2;

/** Which ingest lane is asking. Only "backfill" is ever throttled — see module doc. */
export type PineconeIngestLane = "backfill" | "incremental" | "retrieval";

export interface PineconeMonthWindow {
  startISO: string;
  endISO: string;
  /** Raw fraction of the calendar month elapsed, in (0, 1]. NOT floored — see the assessment. */
  elapsedFraction: number;
}

/** UTC calendar-month key ("YYYY-MM") — the reset boundary Pinecone itself bills on. */
export function pineconeMonthKey(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${month}`;
}

export function pineconeMonthWindow(nowMs: number = Date.now()): PineconeMonthWindow {
  const d = new Date(nowMs);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const total = end - start;
  const elapsed = Math.max(nowMs - start, total / (31 * 24)); // >= ~1h of a month
  return {
    startISO: new Date(start).toISOString(),
    endISO: new Date(end).toISOString(),
    elapsedFraction: Math.min(elapsed / total, 1)
  };
}

/**
 * Monthly write-unit budget from PINECONE_MONTHLY_WU_BUDGET. Returns 0 when unset, empty,
 * non-numeric, or <= 0 — and 0 means the throttle is OFF (accounting still runs).
 */
export function pineconeMonthlyWuBudget(nowMs: number = Date.now()): number {
  // During the remaining trial window, honor an explicit monthly budget (owner 5M
  // Builder week).  0 stays off.  After the calendar, the trial-window snap to
  // free-tier 1.6M wins even if Infisical still holds 5M.
  if (isPineconeTrialActive(nowMs)) {
    const raw = process.env.PINECONE_MONTHLY_WU_BUDGET;
    if (raw == null || String(raw).trim() === "") return 0;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 5_000_000) return 0;
    return Math.floor(parsed);
  }
  const raw = process.env.PINECONE_MONTHLY_WU_BUDGET;
  let configured = 0;
  if (raw != null && String(raw).trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) configured = Math.floor(parsed);
  }
  return pineconeTrialState(nowMs).effectiveMonthlyWriteUnits || configured;
}

interface MonthCounterRow {
  month: string;
  units: number;
  updatedAt?: string;
}

function readMonthCounter(nowMs: number): MonthCounterRow {
  const month = pineconeMonthKey(nowMs);
  try {
    const row = getInternalSetting<MonthCounterRow>(PINECONE_MONTH_WU_KEY);
    // A row from a previous month IS the reset: nothing to delete, the stale total simply
    // stops counting the instant the month key changes.
    if (!row || typeof row !== "object" || row.month !== month) return { month, units: 0 };
    const units = Number(row.units);
    return { month, units: Number.isFinite(units) && units > 0 ? units : 0 };
  } catch {
    return { month, units: 0 };
  }
}

/** Write units recorded so far in the current UTC calendar month. Never throws; 0 on any error. */
export function pineconeMonthToDateWriteUnits(nowMs: number = Date.now()): number {
  return readMonthCounter(nowMs).units;
}

/**
 * Add `units` to the current month's persisted total, rolling the counter over automatically on
 * a month boundary. Called from `meterPineconeUpsert` (rag-metering.ts) right after a successful
 * Pinecone upsert, so the counter measures DELIVERED write units — the same thing Pinecone bills.
 * Returns the new month total. Never throws (a metering failure must never break an upsert).
 */
export function recordPineconeWriteUnits(units: number, nowMs: number = Date.now()): number {
  const current = readMonthCounter(nowMs);
  if (!Number.isFinite(units) || units <= 0) return current.units;
  const next = current.units + Math.ceil(units);
  try {
    setInternalSetting(PINECONE_MONTH_WU_KEY, {
      month: current.month,
      units: next,
      updatedAt: new Date(nowMs).toISOString()
    } satisfies MonthCounterRow);
  } catch {
    return current.units;
  }
  return next;
}

export interface PineconeWuPaceAssessment {
  /** False when PINECONE_MONTHLY_WU_BUDGET is unset/0 — the throttle never fires. */
  enabled: boolean;
  /** UTC "YYYY-MM" this assessment covers. */
  month: string;
  /** Write units recorded month-to-date. */
  mtd: number;
  /** Configured monthly budget (0 when off). */
  budget: number;
  /** Raw fraction of the month elapsed (display), in (0, 1]. */
  elapsedFraction: number;
  /** Linear month-end projection using the floored elapsed fraction. */
  projected: number;
  /** mtd as a percentage of budget (0 when the budget is off). */
  pctUsed: number;
  /** projected as a percentage of budget (0 when the budget is off). */
  projectedPct: number;
  /** True when the projection exceeds the budget, or the budget is already spent. */
  exceeded: boolean;
}

/**
 * Pure pace math (exported for tests and for the admin surface). `budget <= 0` short-circuits to
 * a disabled, never-exceeded assessment so an unconfigured install can't be throttled by a
 * divide-by-zero percentage.
 */
export function assessPineconeWuPace(input: { mtd: number; budget: number; now: number }): PineconeWuPaceAssessment {
  const { elapsedFraction } = pineconeMonthWindow(input.now);
  const mtd = Number.isFinite(input.mtd) && input.mtd > 0 ? input.mtd : 0;
  const budget = Number.isFinite(input.budget) && input.budget > 0 ? Math.floor(input.budget) : 0;
  const paceElapsed = Math.max(elapsedFraction, PINECONE_PACE_ELAPSED_FLOOR);
  const projected = mtd / paceElapsed;
  if (budget <= 0) {
    return {
      enabled: false,
      month: pineconeMonthKey(input.now),
      mtd,
      budget: 0,
      elapsedFraction,
      projected,
      pctUsed: 0,
      projectedPct: 0,
      exceeded: false
    };
  }
  const pctUsed = (mtd / budget) * 100;
  const projectedPct = (projected / budget) * 100;
  return {
    enabled: true,
    month: pineconeMonthKey(input.now),
    mtd,
    budget,
    elapsedFraction,
    projected,
    pctUsed,
    projectedPct,
    // Both conditions matter: the projection catches a runaway trend early, and the absolute
    // check catches a month whose budget is already spent (where the projection could dip back
    // under 100% late in the month).
    exceeded: projected > budget || mtd >= budget
  };
}

/**
 * Current pace state read from the persisted counter. Cheap and synchronous — safe for the
 * admin RAG-coverage route. Never throws.
 */
export function pineconeWuPaceState(nowMs: number = Date.now()): PineconeWuPaceAssessment {
  return assessPineconeWuPace({
    mtd: pineconeMonthToDateWriteUnits(nowMs),
    budget: pineconeMonthlyWuBudget(nowMs),
    now: nowMs
  });
}

function formatUnits(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * Emit the month's single pace advisory (one per UTC calendar month, watermarked in internal
 * settings). Deliberately NOT cleared when the pace recovers: a metric that oscillates around
 * the threshold would otherwise re-notify all month, which is the noise this dedup exists to
 * prevent. Never throws.
 */
async function advisePaceOnce(pace: PineconeWuPaceAssessment): Promise<boolean> {
  try {
    if (getInternalSetting<string>(PINECONE_MONTH_PACE_ADVISED_KEY) === pace.month) return false;
    setInternalSetting(PINECONE_MONTH_PACE_ADVISED_KEY, pace.month);
    audit(
      "pinecone_wu_pace_throttle",
      {
        month: pace.month,
        mtd: pace.mtd,
        budget: pace.budget,
        projected: Math.round(pace.projected),
        projectedPct: Number(pace.projectedPct.toFixed(1))
      },
      "local"
    );
    console.warn(
      `[pinecone-wu-pace] ${formatUnits(pace.mtd)} write units used in ${pace.month} ` +
        `(${pace.pctUsed.toFixed(0)}% of ${formatUnits(pace.budget)}); projected month-end ` +
        `${formatUnits(pace.projected)} (${pace.projectedPct.toFixed(0)}%). Bulk backfill paused; ` +
        "incremental ingest and retrieval unaffected."
    );
    await alertStorageWarning(
      "pinecone_monthly_wu_pace",
      `Pinecone write units are on pace to exceed the monthly budget: ${formatUnits(pace.mtd)} used ` +
        `month-to-date (${pace.pctUsed.toFixed(0)}% of ${formatUnits(pace.budget)}), projected month-end ` +
        `${formatUnits(pace.projected)} (${pace.projectedPct.toFixed(0)}%). Bulk RAG backfill is paused ` +
        "for the rest of the month; incremental filing ingest and retrieval are unaffected. Raise " +
        "PINECONE_MONTHLY_WU_BUDGET (or set it to 0) to resume backfill."
    );
    return true;
  } catch {
    // Advisory only — never let a notification failure change the throttle decision.
    return false;
  }
}

export interface PineconePaceGateResult {
  /** True only for the backfill lane, only when a budget is set, and only when pace exceeds it. */
  throttled: boolean;
  pace: PineconeWuPaceAssessment;
}

/**
 * The lane-aware throttle gate.
 *
 * - `lane: "incremental"` / `"retrieval"` — ALWAYS `throttled: false`, and the assessment is
 *   returned without any advisory. Daily filing ingest and retrieval must never be paced off.
 * - `lane: "backfill"` — `throttled: true` when a budget is configured AND the month-end
 *   projection exceeds it (or the budget is already spent). Emits at most one advisory per
 *   calendar month.
 *
 * Never throws: any failure fails OPEN (backfill continues), matching every other advisory
 * guard in this codebase.
 *
 * The returned `pace` is a gate-decision artifact, not a display value: when the budget is off
 * it reports `mtd: 0` because the gate deliberately skips the DB read on the hot worker tick.
 * Anything that DISPLAYS the number (admin RAG-coverage) must call `pineconeWuPaceState()`.
 */
export async function pineconeBackfillPaceGate(
  lane: PineconeIngestLane,
  nowMs: number = Date.now()
): Promise<PineconePaceGateResult> {
  try {
    const budget = pineconeMonthlyWuBudget(nowMs);
    // Cheap exit before any DB read: budget off, or a lane this guard never touches.
    if (budget <= 0 || lane !== "backfill") {
      return {
        throttled: false,
        pace: assessPineconeWuPace({
          mtd: budget > 0 ? pineconeMonthToDateWriteUnits(nowMs) : 0,
          budget,
          now: nowMs
        })
      };
    }
    const pace = assessPineconeWuPace({ mtd: pineconeMonthToDateWriteUnits(nowMs), budget, now: nowMs });
    if (!pace.exceeded) return { throttled: false, pace };
    await advisePaceOnce(pace);
    return { throttled: true, pace };
  } catch {
    return {
      throttled: false,
      pace: assessPineconeWuPace({ mtd: 0, budget: 0, now: nowMs })
    };
  }
}
