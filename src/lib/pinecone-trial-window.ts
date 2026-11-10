// Pinecone Standard trial calendar + post-trial free-tier rollback.
//
// Why this exists (owner, 2026-08-16): the rolling-24h write fuse is a FLAT burst cap
// (prod 2.5M WUs). It fired while the Standard trial still had ~$238 of $300 and 14 of 21
// days left — spend was behind the calendar, not ahead of it. This module:
//   1. During the trial, sizes the daily write fuse from remaining credit / remaining days
//      so ingest keeps going until the $300 is used in proportion to time left.
//   2. On the trial end day, snaps write/text/monthly knobs to the documented free/Starter
//      values even if Infisical still holds the trial-sized numbers.
//
// Retrieval is never gated. The owner can delete the watermark or set
// PINECONE_TRIAL_ENDS_AT=off. Do not import "os" or "node:" specifiers (scheduler path).

import { audit, getInternalSetting, setInternalSetting } from "./db";
import { alertStorageWarning } from "./db-health";

/** This Standard trial ends at 00:00 UTC on 2026-08-27 (owner 2026-08-19: 7 days from then). */
export const PINECONE_CURRENT_TRIAL_ENDS_AT = "2026-08-27T00:00:00.000Z";
export const PINECONE_TRIAL_CREDIT_USD = 300;
/** Standard serverless write-unit list price used to pace remaining trial dollars. */
export const PINECONE_WU_USD_PER_MILLION = 4;
/** Infisical trial fuses are 1M–2.5M. A configured daily fuse at or above this is "trial-sized". */
export const PINECONE_TRIAL_DAILY_FUSE_HINT = 1_000_000;
/** Documented after-trial daily fuse (60k * 31 ~= 1.86M, inside a 2M-WU Starter/Builder month). */
export const PINECONE_FREE_TIER_WU_PER_DAY = 60_000;
export const PINECONE_FREE_TIER_TEXTS_PER_DAY = 20_000;
/** 80% of a 2M-WU month — same number as the 2026-08-09 after-trial table. */
export const PINECONE_FREE_TIER_MONTHLY_WU = 1_600_000;
/**
 * Keep full-steam ingest until about this much trial credit remains, then pace the rest
 * so it lasts through the trial instead of dumping the last dollars in one day.
 * Override with PINECONE_TRIAL_RESERVE_USD.
 */
export const PINECONE_TRIAL_RESERVE_USD = 45;
export const PINECONE_TRIAL_ROLLED_BACK_KEY = "pinecone:trialRolledBackAt";
/**
 * Smallest daily write fuse that can accept one typical filing-sized upsert (~28 WU).
 * Clamping the fuse to leftover local-MTD remainder (15 WU) skips every document and
 * leaves used=0 forever — that is a deadlock, not a spent trial.
 */
export const PINECONE_MIN_USABLE_DAILY_WU = 2_048;
/** Smallest ingest-text cap that can start a document. A 1-text park never writes. */
export const PINECONE_MIN_USABLE_TEXTS_PER_DAY = 32;
/**
 * If the local month counter implies remaining trial dollars at or below this, do not
 * shrink the daily fuse.  That counter is app-recorded estimates, not Pinecone's bill.
 * Hybrid #2820 (processed writes) did not reset it, so pre-hybrid full-body upserts can
 * still make the remainder look spent while the Standard trial has credit left.
 */
export const PINECONE_LOCAL_REMAINING_UNTRUSTED_USD = 1;
const DAY_MS = 24 * 60 * 60_000;
const MAX_TRIAL_DAILY_WU = 10_000_000;

function parseEndsAt(raw: string | undefined): number | null | "off" {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^(0|off|never|false|no)$/i.test(trimmed)) return "off";
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

function configuredDailyFromEnv(): number {
  const parsed = Number(process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 200_000;
}

/**
 * When the trial calendar ends (UTC ms), or null when auto-rollback is off.
 * Explicit PINECONE_TRIAL_ENDS_AT wins. "off"/"0"/"never" disables the window.
 * Otherwise a trial-sized daily fuse (>= 1M) implies THIS trial's 2026-08-27 end.
 */
export function isPineconeTrialCalendarOff(): boolean {
  return parseEndsAt(process.env.PINECONE_TRIAL_ENDS_AT) === "off";
}

export function pineconeTrialEndsAtMs(nowMs: number = Date.now()): number | null {
  if (isPineconeTrialCalendarOff()) return null;
  const parsed = parseEndsAt(process.env.PINECONE_TRIAL_ENDS_AT);
  if (typeof parsed === "number") return parsed;
  if (configuredDailyFromEnv() >= PINECONE_TRIAL_DAILY_FUSE_HINT) {
    return Date.parse(PINECONE_CURRENT_TRIAL_ENDS_AT);
  }
  return null;
}

export function isPineconeTrialActive(nowMs: number = Date.now()): boolean {
  const ends = pineconeTrialEndsAtMs(nowMs);
  return ends != null && nowMs < ends;
}

export function pineconeTrialRemainingDays(nowMs: number = Date.now()): number {
  const ends = pineconeTrialEndsAtMs(nowMs);
  if (ends == null) return 0;
  if (nowMs >= ends) return 0;
  return Math.max(1, Math.ceil((ends - nowMs) / DAY_MS));
}

function creditUsd(): number {
  const parsed = Number(process.env.PINECONE_TRIAL_CREDIT_USD);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return PINECONE_TRIAL_CREDIT_USD;
}

function wuUsdPerMillion(): number {
  const parsed = Number(process.env.PINECONE_WU_USD_PER_MILLION);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return PINECONE_WU_USD_PER_MILLION;
}

function reserveUsd(): number {
  const parsed = Number(process.env.PINECONE_TRIAL_RESERVE_USD);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return PINECONE_TRIAL_RESERVE_USD;
}

export interface PineconeTrialAssessment {
  active: boolean;
  endsAt: string | null;
  remainingDays: number;
  creditUsd: number;
  spentUsd: number;
  remainingUsd: number;
  remainingWriteUnits: number;
  pacedDailyWriteUnits: number;
  effectiveDailyWriteUnits: number;
  effectiveTextsPerDay: number;
  effectiveMonthlyWriteUnits: number;
  /** full-steam = remaining credit still above the reserve; finish = last $40-50 paced to trial end. */
  phase: "full-steam" | "finish" | "idle";
  mode: "trial" | "free" | "configured";
  /**
   * True when local month-to-date WUs imply the $300 trial is already gone.
   * The daily fuse then stays at the configured trial cap so writes continue;
   * Pinecone itself 429s if credit is actually exhausted.
   */
  localMtdUntrusted: boolean;
}

export function assessPineconeTrialWindow(input: {
  now: number;
  mtdWriteUnits: number;
  configuredDailyWriteUnits: number;
  configuredTextsPerDay: number;
  configuredMonthlyWriteUnits: number;
}): PineconeTrialAssessment {
  const endsMs = pineconeTrialEndsAtMs(input.now);
  const active = endsMs != null && input.now < endsMs;
  const remainingDays = active ? Math.max(1, Math.ceil((endsMs! - input.now) / DAY_MS)) : 0;
  const price = wuUsdPerMillion();
  const credit = creditUsd();
  const spentUsd = Math.max(0, (Math.max(0, input.mtdWriteUnits) / 1_000_000) * price);
  const remainingUsd = Math.max(0, credit - spentUsd);
  const remainingWriteUnits = Math.floor((remainingUsd / price) * 1_000_000);
  const pacedDailyWriteUnits = remainingDays > 0
    ? Math.max(0, Math.min(
        MAX_TRIAL_DAILY_WU,
        remainingWriteUnits,
        Math.floor(remainingWriteUnits / remainingDays)
      ))
    : 0;

  if (active) {
    // Full steam while remaining credit is above the reserve.  Raise the fuse only when
    // even the configured trial cap would leave dollars unused at trial end.  At/under
    // the reserve, pace remaining / remaining days so the last $40-50 lasts the trial
    // (unless that pace is still above the configured cap — then keep going).
    //
    // Do NOT clamp the daily fuse to remainingWriteUnits.  That leftover-lifetime cap
    // is what produced "used 0 of 15 WUs, attempted 28, skipped 1" — a single document
    // larger than the remainder can never start, so used stays 0.
    const wouldMissTrialAtConfiguredCap = pacedDailyWriteUnits > input.configuredDailyWriteUnits;
    const belowReserve = remainingUsd <= reserveUsd();
    const localMtdUntrusted = remainingUsd <= PINECONE_LOCAL_REMAINING_UNTRUSTED_USD;
    const phase: "full-steam" | "finish" = !localMtdUntrusted && belowReserve && !wouldMissTrialAtConfiguredCap
      ? "finish"
      : "full-steam";
    const rawDaily = localMtdUntrusted || phase === "full-steam"
      ? Math.max(input.configuredDailyWriteUnits, pacedDailyWriteUnits, PINECONE_MIN_USABLE_DAILY_WU)
      : Math.max(pacedDailyWriteUnits, PINECONE_MIN_USABLE_DAILY_WU);
    return {
      active: true,
      endsAt: new Date(endsMs!).toISOString(),
      remainingDays,
      creditUsd: credit,
      spentUsd,
      remainingUsd,
      remainingWriteUnits,
      pacedDailyWriteUnits,
      effectiveDailyWriteUnits: Math.min(MAX_TRIAL_DAILY_WU, rawDaily),
      effectiveTextsPerDay: Math.max(input.configuredTextsPerDay, PINECONE_MIN_USABLE_TEXTS_PER_DAY),
      // Honor Builder-sized monthly budgets (owner 5M this week).  Ignore a
      // leftover Starter 2M so it cannot park ingest during the remaining trial.
      effectiveMonthlyWriteUnits: input.configuredMonthlyWriteUnits >= 5_000_000
        ? input.configuredMonthlyWriteUnits
        : 0,
      phase,
      mode: "trial",
      localMtdUntrusted
    };
  }

  const leftoverTrialFuse = !isPineconeTrialCalendarOff()
    && input.configuredDailyWriteUnits >= PINECONE_TRIAL_DAILY_FUSE_HINT;
  if (endsMs != null || leftoverTrialFuse) {
    // Owner 2026-08-21: automatically snap to free/Starter fuses when the
    // calendar ends (2026-08-27, six days from the ask).  Infisical can keep
    // the 5M trial numbers; runtime uses these until the owner sets
    // PINECONE_TRIAL_ENDS_AT=off and pays for Builder.
    return {
      active: false,
      endsAt: endsMs != null ? new Date(endsMs).toISOString() : PINECONE_CURRENT_TRIAL_ENDS_AT,
      remainingDays: 0,
      creditUsd: credit,
      spentUsd,
      remainingUsd,
      remainingWriteUnits,
      pacedDailyWriteUnits: 0,
      effectiveDailyWriteUnits: PINECONE_FREE_TIER_WU_PER_DAY,
      effectiveTextsPerDay: Math.min(input.configuredTextsPerDay, PINECONE_FREE_TIER_TEXTS_PER_DAY),
      effectiveMonthlyWriteUnits: PINECONE_FREE_TIER_MONTHLY_WU,
      phase: "idle",
      mode: "free",
      localMtdUntrusted: false
    };
  }

  return {
    active: false,
    endsAt: null,
    remainingDays: 0,
    creditUsd: credit,
    spentUsd,
    remainingUsd,
    remainingWriteUnits,
    pacedDailyWriteUnits: 0,
    effectiveDailyWriteUnits: input.configuredDailyWriteUnits,
    effectiveTextsPerDay: input.configuredTextsPerDay,
    effectiveMonthlyWriteUnits: input.configuredMonthlyWriteUnits,
    phase: "idle",
    mode: "configured",
    localMtdUntrusted: false
  };
}

function configuredTextsFromEnv(): number {
  const parsed = Number(process.env.RAG_INGEST_MAX_TEXTS_PER_DAY);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 20_000;
}

function configuredMonthlyFromEnv(): number {
  const raw = process.env.PINECONE_MONTHLY_WU_BUDGET;
  if (raw == null || String(raw).trim() === "") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

/** Live assessment. `mtdWriteUnits` is the calendar-month delivered-WU counter. */
export function pineconeTrialState(
  nowMs: number = Date.now(),
  mtdWriteUnits: number = 0
): PineconeTrialAssessment {
  return assessPineconeTrialWindow({
    now: nowMs,
    mtdWriteUnits,
    configuredDailyWriteUnits: configuredDailyFromEnv(),
    configuredTextsPerDay: configuredTextsFromEnv(),
    configuredMonthlyWriteUnits: configuredMonthlyFromEnv()
  });
}

/**
 * One storage_warning the first time we snap to free-tier knobs. Never throws.
 * Safe to call from the scheduler every tick.
 */
export async function maybeAdvisePineconeTrialRollback(
  nowMs: number = Date.now(),
  mtdWriteUnits: number = 0
): Promise<boolean> {
  try {
    const state = pineconeTrialState(nowMs, mtdWriteUnits);
    if (state.mode !== "free") return false;
    if (getInternalSetting<string>(PINECONE_TRIAL_ROLLED_BACK_KEY)) return false;
    setInternalSetting(PINECONE_TRIAL_ROLLED_BACK_KEY, new Date(nowMs).toISOString());
    audit(
      "pinecone_trial_rollback",
      {
        endsAt: state.endsAt,
        effectiveDailyWriteUnits: state.effectiveDailyWriteUnits,
        effectiveTextsPerDay: state.effectiveTextsPerDay,
        effectiveMonthlyWriteUnits: state.effectiveMonthlyWriteUnits
      },
      "local"
    );
    console.warn(
      `[pinecone-trial] Standard trial ended; ingest knobs now free-tier ` +
        `(${state.effectiveDailyWriteUnits} WU/day, ${state.effectiveTextsPerDay} texts/day, ` +
        `${state.effectiveMonthlyWriteUnits} WU/month). Retrieval is unchanged.`
    );
    await alertStorageWarning(
      "pinecone_trial_rollback",
      `Pinecone Standard trial ended.  Ingest now uses free-tier caps: ` +
        `${state.effectiveDailyWriteUnits.toLocaleString("en-US")} write units/day, ` +
        `${state.effectiveTextsPerDay.toLocaleString("en-US")} embed texts/day, ` +
        `${state.effectiveMonthlyWriteUnits.toLocaleString("en-US")} write units/month.  ` +
        "Retrieval is unchanged.  Raise PINECONE_TRIAL_ENDS_AT only if a new trial is open."
    );
    return true;
  } catch {
    return false;
  }
}
