// G8(a) — hard per-user/day LLM budget ceiling. Extracted to its own module (from triggers.ts) so it
// can be enforced at the spend primitives (withLlmGeneration, retrieveContextDetailed) and at the
// runStrategyOnce gate WITHOUT a strategy↔triggers import cycle. triggers.ts re-exports these for
// callers that already import from it (tests).
//
// CONFIG (who sets it / how to modify): the live cap is a per-user setting
// (`user_settings.llm_daily_budget`), editable in Settings → Daily LLM Budget and iOS
// Account & Settings, and via `GET/PATCH /api/settings/llm-budget`. That is NOT an Infisical
// secret. Legacy `policy.tuning.llmDailyTokenBudget` / `llmDailyCostBudgetUsd` still bind when
// the user setting is unset. Env `TRIGGER_LLM_DAILY_*` is a retired operator default only —
// do not put a per-user cap back in Infisical. 0 / unset on every tier = no ceiling (default OFF).
//
// ENFORCEMENT: `checkLlmDailyBudget` is the ledger read; `isOverLlmBudget` / `assertWithinLlmBudget`
// are the guards the spend primitives call, so EVERY current and future LLM/RAG spend site is covered
// by one check rather than per-call-site gates. When a cap is SET and today's ledger cannot be
// read, the check fail-closes to skip (never overrun).
import { randomUUID } from "crypto";
import {
  DAILY_RESET_TIME_ZONE,
  deleteUserSetting,
  getDb,
  getPolicy,
  getUserSetting,
  setUserSetting,
  startOfDayInTimeZone
} from "./db";
import { getLlmUsageSummary } from "./llm-usage";
import { getRagUsageSummary } from "./rag-metering";
import type { TradingPolicy } from "./types";

export const LLM_DAILY_BUDGET_SETTING_KEY = "llm_daily_budget";

export interface UserLlmDailyBudget {
  tokenBudget?: number;
  costBudgetUsd?: number;
}

export type LlmBudgetLimitSource = "user" | "policy" | "env" | "none";

export interface LlmBudgetResolvedLimits {
  tokenLimit: number;
  costLimit: number;
  tokenSource: LlmBudgetLimitSource;
  costSource: LlmBudgetLimitSource;
}

function asOptionalFiniteNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** Stored per-user overrides only (what the Settings UI edits). Missing key = inherit next tier. */
export function getUserLlmDailyBudget(userId: string): UserLlmDailyBudget {
  try {
    const stored = getUserSetting<UserLlmDailyBudget | null>(userId, LLM_DAILY_BUDGET_SETTING_KEY, null);
    if (!stored || typeof stored !== "object") return {};
    return {
      tokenBudget: asOptionalFiniteNumber(stored.tokenBudget),
      costBudgetUsd: asOptionalFiniteNumber(stored.costBudgetUsd)
    };
  } catch {
    return {};
  }
}

/** Merge a user-settings patch. `null` clears that field; omit a field to leave it. */
export function setUserLlmDailyBudget(
  userId: string,
  patch: { tokenBudget?: number | null; costBudgetUsd?: number | null }
): UserLlmDailyBudget {
  const next: UserLlmDailyBudget = { ...getUserLlmDailyBudget(userId) };
  if (patch.tokenBudget === null) {
    delete next.tokenBudget;
  } else if (asOptionalFiniteNumber(patch.tokenBudget) !== undefined) {
    next.tokenBudget = patch.tokenBudget as number;
  }
  if (patch.costBudgetUsd === null) {
    delete next.costBudgetUsd;
  } else if (asOptionalFiniteNumber(patch.costBudgetUsd) !== undefined) {
    next.costBudgetUsd = patch.costBudgetUsd as number;
  }
  if (next.tokenBudget === undefined && next.costBudgetUsd === undefined) {
    deleteUserSetting(userId, LLM_DAILY_BUDGET_SETTING_KEY);
    return {};
  }
  setUserSetting(userId, LLM_DAILY_BUDGET_SETTING_KEY, next);
  return next;
}

function envNum(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Resolve one dimension. User setting wins, then legacy policy.tuning, then retired env default.
 *  An EXPLICIT finite value always wins over a lower tier — including `0`, which means "no limit"
 *  (opting OUT of an operator-set default). Only `undefined` inherits the next tier. */
function resolveLimitFromTiers(
  userValue: number | undefined,
  policyValue: number | undefined,
  envName: string
): { limit: number; source: LlmBudgetLimitSource } {
  if (asOptionalFiniteNumber(userValue) !== undefined) {
    return { limit: userValue! > 0 ? userValue! : Number.POSITIVE_INFINITY, source: "user" };
  }
  if (asOptionalFiniteNumber(policyValue) !== undefined) {
    return { limit: policyValue! > 0 ? policyValue! : Number.POSITIVE_INFINITY, source: "policy" };
  }
  const env = envNum(envName, 0);
  if (env > 0) return { limit: env, source: "env" };
  return { limit: Number.POSITIVE_INFINITY, source: "none" };
}

export interface LlmBudgetDecision {
  ok: boolean;
  reason?: "token_budget" | "cost_budget" | "ledger_unavailable";
  tokensToday?: number;
  costUsdToday?: number;
  tokenLimit?: number;
  costLimitUsd?: number;
}

/**
 * Hard per-user/day LLM usage ceiling. Reads user_settings (then legacy policy.tuning, then
 * retired env), then sums TODAY's usage (America/New_York day) for `userId`. Default OFF.
 * When a cap is set and the ledger cannot be read, returns ok:false (fail-closed skip).
 */
export function checkLlmDailyBudget(userId: string, now: Date = new Date(), connectedAccountId?: string): LlmBudgetDecision {
  const { tokenLimit, costLimit } = resolveLlmLimits(userId, connectedAccountId);
  if (!Number.isFinite(tokenLimit) && !Number.isFinite(costLimit)) return { ok: true };

  const sinceIso = startOfDayInTimeZone(now, DAILY_RESET_TIME_ZONE).toISOString();
  let tokensToday: number;
  let costUsdToday: number;
  try {
    const usage = sumLedgerUsage(userId, sinceIso);
    tokensToday = usage.tokens;
    costUsdToday = usage.costUsd;
  } catch {
    // Cap is set: never let a ledger fault overrun the day. Callers skip LLM/RAG.
    return { ok: false, reason: "ledger_unavailable", tokenLimit, costLimitUsd: costLimit };
  }

  if (Number.isFinite(tokenLimit) && tokensToday >= tokenLimit) {
    return { ok: false, reason: "token_budget", tokensToday, costUsdToday, tokenLimit, costLimitUsd: costLimit };
  }
  if (Number.isFinite(costLimit) && costUsdToday >= costLimit) {
    return { ok: false, reason: "cost_budget", tokensToday, costUsdToday, tokenLimit, costLimitUsd: costLimit };
  }
  return { ok: true, tokensToday, costUsdToday, tokenLimit, costLimitUsd: costLimit };
}

// ── Concurrency reservation (TOCTOU fix for concurrent same-user account runs) ────────────────────
//
// checkLlmDailyBudget above is a ledger READ, not a reservation: the scheduler runs up to
// MAX_CONCURRENCY same-user account runs at once, and each can read "under budget" before any records
// its spend, overshooting the ceiling. A per-USER reservation (keyed by userId, since the ledger
// ceiling is per-user) is the missing admission control: a run reserves its worst-case estimate before
// spending; a concurrent run's reserve sees that hold and skips LLM instead of double-committing.
// Stored in the `settings` KV row (no migration), CAS'd inside a transaction().immediate() exactly like
// acquireStrategyLock. Crash-safe-ish: a run that dies without releasing frees its hold after the TTL.

interface LlmReservation { id: string; tokens: number; costUsd: number; reservedAt: string; expiresAt: string }

// TTL for a reservation hold. It must comfortably exceed the longest strategy run + its fire-and-forget
// post-mortem so a LIVE run's reservation never expires before its finally release — an early expiry would
// let a queued same-user run reserve the same headroom and reopen the concurrent-run TOCTOU this closes.
// The TTL is only a backstop for a CRASHED run that never releases; the normal path releases explicitly.
// Env LLM_RESERVATION_TTL_MS, default 15min (well above a worst-case Bull+Bear+Red-Team+RAG+reflection run).
function reservationTtlMs(): number {
  const v = Number(process.env.LLM_RESERVATION_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 15 * 60_000;
}

const reservationKey = (userId: string): string => `llm_budget_reservation:${userId}`;

/** Resolve the per-user daily token/cost limits (user settings → legacy policy → retired env). */
export function resolveLlmLimits(userId: string, connectedAccountId?: string): LlmBudgetResolvedLimits {
  const user = getUserLlmDailyBudget(userId);
  let tuning: TradingPolicy["tuning"];
  try {
    tuning = getPolicy(userId, connectedAccountId).tuning;
  } catch {
    tuning = undefined;
  }
  const token = resolveLimitFromTiers(user.tokenBudget, tuning?.llmDailyTokenBudget, "TRIGGER_LLM_DAILY_TOKEN_BUDGET");
  const cost = resolveLimitFromTiers(user.costBudgetUsd, tuning?.llmDailyCostBudgetUsd, "TRIGGER_LLM_DAILY_COST_BUDGET_USD");
  return {
    tokenLimit: token.limit,
    costLimit: cost.limit,
    tokenSource: token.source,
    costSource: cost.source
  };
}

/** Today's committed LLM+RAG ledger usage for `userId` (the same sum checkLlmDailyBudget uses). */
function sumLedgerUsage(userId: string, sinceIso: string): { tokens: number; costUsd: number } {
  const llmRows = getLlmUsageSummary({ sinceIso }).filter((r) => r.userId === userId);
  let tokens = llmRows.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);
  let costUsd = llmRows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const ragRows = getRagUsageSummary({ sinceIso }).filter((r) => r.userId === userId);
  tokens += ragRows.reduce((sum, r) => sum + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0);
  costUsd += ragRows.reduce((sum, r) => sum + (r.costEstUsd ?? 0), 0);
  return { tokens, costUsd };
}

/** Conservative worst-case per-run estimate (env-tunable). It's a ceiling GUARD, not exact accounting —
 *  the ledger stays truth; too-high wastes headroom, too-low re-opens overshoot. */
function runReservationEstimate(): { tokens: number; costUsd: number } {
  return { tokens: envNum("LLM_RUN_RESERVATION_TOKENS", 80_000), costUsd: envNum("LLM_RUN_RESERVATION_COST_USD", 1) };
}

/**
 * Atomically reserve `estTokens`/`estCostUsd` of today's LLM+RAG headroom for `userId`. Returns
 * `{ok:false}` when today's ledger usage + live reservations + this estimate would meet/exceed a finite
 * limit — that's the serialization point: a second concurrent same-user run's reserve fails because the
 * first's reservation already consumed the headroom. No ceiling configured → `{ok:true}` with no
 * reservation (default-OFF preserved). Fail-closed on DB error to `{ok:false}` — the CALLER must treat
 * that as "skip LLM", never as a failed run.
 */
export function reserveLlmBudget(
  userId: string,
  estTokens: number,
  estCostUsd: number,
  now: Date = new Date(),
  connectedAccountId?: string
): { ok: boolean; reservationId?: string; reason?: "token_budget" | "cost_budget" | "ledger_unavailable" } {
  const { tokenLimit, costLimit } = resolveLlmLimits(userId, connectedAccountId);
  if (!Number.isFinite(tokenLimit) && !Number.isFinite(costLimit)) return { ok: true }; // no ceiling → no reservation
  try {
    const db = getDb();
    const key = reservationKey(userId);
    const nowMs = now.getTime();
    const sinceIso = startOfDayInTimeZone(now, DAILY_RESET_TIME_ZONE).toISOString();
    const tx = db.transaction(() => {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      let reservations: LlmReservation[] = [];
      if (row) {
        try {
          reservations = ((JSON.parse(row.value) as { reservations?: LlmReservation[] }).reservations ?? []);
        } catch {
          reservations = []; // malformed → reclaim (mirrors acquireStrategyLock)
        }
      }
      reservations = reservations.filter((r) => new Date(r.expiresAt).getTime() > nowMs); // drop expired (crash-safe TTL)
      const ledger = sumLedgerUsage(userId, sinceIso);
      const reservedTokens = reservations.reduce((s, r) => s + (r.tokens ?? 0), 0);
      const reservedCost = reservations.reduce((s, r) => s + (r.costUsd ?? 0), 0);
      // Admission rule. The FIRST run is always admitted when the committed ledger is under the limit —
      // its OWN worst-case estimate must never refuse it, or an account whose budget is smaller than the
      // estimate (e.g. < 80k tokens / < $1) would skip LLM all day even at zero usage. Real spend is still
      // capped per-call by assertWithinLlmBudget. Refuse only when (a) the committed ledger already meets
      // the limit, or (b) a CONCURRENT run's live reservation already claims the headroom this estimate
      // needs — case (b) IS the TOCTOU serialization (a second same-user run stands down).
      const hasConcurrentReservation = reservations.length > 0;
      if (Number.isFinite(tokenLimit) && ledger.tokens >= tokenLimit) return { ok: false as const, reason: "token_budget" as const };
      if (Number.isFinite(costLimit) && ledger.costUsd >= costLimit) return { ok: false as const, reason: "cost_budget" as const };
      if (hasConcurrentReservation) {
        if (Number.isFinite(tokenLimit) && ledger.tokens + reservedTokens + estTokens >= tokenLimit) {
          return { ok: false as const, reason: "token_budget" as const };
        }
        if (Number.isFinite(costLimit) && ledger.costUsd + reservedCost + estCostUsd >= costLimit) {
          return { ok: false as const, reason: "cost_budget" as const };
        }
      }
      const id = randomUUID();
      reservations.push({ id, tokens: estTokens, costUsd: estCostUsd, reservedAt: now.toISOString(), expiresAt: new Date(nowMs + reservationTtlMs()).toISOString() });
      db.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).run(key, JSON.stringify({ reservations }), now.toISOString());
      return { ok: true as const, reservationId: id };
    });
    return tx.immediate() as { ok: boolean; reservationId?: string; reason?: "token_budget" | "cost_budget" | "ledger_unavailable" };
  } catch {
    return { ok: false, reason: "ledger_unavailable" }; // fail-closed; caller degrades to "skip LLM"
  }
}

/** Convenience: reserve a strategy run's worst-case estimate. */
export function reserveLlmRunBudget(
  userId: string,
  connectedAccountId?: string,
  now: Date = new Date()
): { ok: boolean; reservationId?: string; reason?: "token_budget" | "cost_budget" | "ledger_unavailable" } {
  const est = runReservationEstimate();
  return reserveLlmBudget(userId, est.tokens, est.costUsd, now, connectedAccountId);
}

/** Release a reservation (and drop any expired ones). Runs in a `finally`; never throws. */
export function releaseLlmReservation(userId: string, reservationId: string, now: Date = new Date()): void {
  try {
    const db = getDb();
    const key = reservationKey(userId);
    const nowMs = now.getTime();
    db.transaction(() => {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      if (!row) return;
      let reservations: LlmReservation[] = [];
      try {
        reservations = ((JSON.parse(row.value) as { reservations?: LlmReservation[] }).reservations ?? []);
      } catch {
        reservations = [];
      }
      const remaining = reservations.filter((r) => r.id !== reservationId && new Date(r.expiresAt).getTime() > nowMs);
      if (remaining.length === 0) {
        db.prepare("DELETE FROM settings WHERE key = ?").run(key);
      } else {
        db.prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        ).run(key, JSON.stringify({ reservations: remaining }), now.toISOString());
      }
    })();
  } catch {
    // release must never throw — it runs in a finally block
  }
}

/** Sum of a user's live (non-expired) reservations. Exposed for tests / diagnostics. */
export function reservedLlmSpend(userId: string, now: Date = new Date()): { tokens: number; costUsd: number } {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(reservationKey(userId)) as { value: string } | undefined;
    if (!row) return { tokens: 0, costUsd: 0 };
    let reservations: LlmReservation[] = [];
    try {
      reservations = ((JSON.parse(row.value) as { reservations?: LlmReservation[] }).reservations ?? []);
    } catch {
      return { tokens: 0, costUsd: 0 };
    }
    const nowMs = now.getTime();
    const live = reservations.filter((r) => new Date(r.expiresAt).getTime() > nowMs);
    return {
      tokens: live.reduce((s, r) => s + (r.tokens ?? 0), 0),
      costUsd: live.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    };
  } catch {
    return { tokens: 0, costUsd: 0 };
  }
}

/** True when `userId` is at/over their daily LLM budget. Cheap wrapper used by the spend primitives. */
export function isOverLlmBudget(userId: string, connectedAccountId?: string): boolean {
  return !checkLlmDailyBudget(userId, new Date(), connectedAccountId).ok;
}

/** Thrown by `assertWithinLlmBudget` — a distinct type so callers can recognize a budget stop vs. a
 *  provider/network error. */
export class LlmBudgetExceededError extends Error {
  readonly reason?: "token_budget" | "cost_budget" | "ledger_unavailable";
  constructor(decision: LlmBudgetDecision) {
    super(
      decision.reason === "ledger_unavailable"
        ? "Daily LLM budget is set but today's usage ledger could not be read — skipping LLM/RAG spend (fail-closed)."
        : `Daily LLM budget ceiling reached (${decision.reason ?? "budget"}): ` +
          `tokensToday=${decision.tokensToday ?? "?"} (limit ${decision.tokenLimit ?? "∞"}), ` +
          `costUsdToday=${decision.costUsdToday ?? "?"} (limit ${decision.costLimitUsd ?? "∞"}). ` +
          `Skipping LLM/RAG spend for the rest of the day.`
    );
    this.name = "LlmBudgetExceededError";
    this.reason = decision.reason;
  }
}

/** Throw `LlmBudgetExceededError` when `userId` is over budget — the durable enforcement primitive
 *  the LLM generation wrapper calls so no model spend slips past the ceiling. No-op (returns) when
 *  under budget or no ceiling is configured. */
export function assertWithinLlmBudget(userId: string, connectedAccountId?: string): void {
  const decision = checkLlmDailyBudget(userId, new Date(), connectedAccountId);
  if (!decision.ok) throw new LlmBudgetExceededError(decision);
}

// ── Operator-level monthly spend ceiling ─────────────────────────────────────────────
//
// LLM_SPEND_CEILING is a global operator-set monthly USD limit (summed across all users).
// When set, the scheduler checks total LLM+RAG spend for the current calendar month before
// allowing any LLM work. Distinct from the per-user daily limits above — this is the operator's
// "stop everything" cap, checked once per tick after the single-leader gate.

/** Resolve the operator-level monthly ceiling. Undefined = no ceiling. */
function monthlySpendCeilingUsd(): number | undefined {
  const v = Number(process.env.LLM_SPEND_CEILING);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Total LLM+RAG cost (USD) across all users for the current calendar month. Never throws. */
function totalMonthlyLlmCostUsd(now: Date = new Date()): number {
  try {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const db = getDb();
    const llmRow = db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_usage WHERE created_at >= ?")
      .get(monthStart) as { total: number } | undefined;
    const ragRow = db
      .prepare("SELECT COALESCE(SUM(cost_est_usd), 0) AS total FROM rag_usage WHERE created_at >= ?")
      .get(monthStart) as { total: number } | undefined;
    return (llmRow?.total ?? 0) + (ragRow?.total ?? 0);
  } catch {
    return 0; // fail open for the ceiling — never block LLM because we can't read the ledger
  }
}

export interface MonthlyCeilingResult {
  ok: boolean;
  totalUsd: number;
  ceilingUsd: number | undefined;
}

/**
 * Check the operator-level monthly LLM spend ceiling. Called from the scheduler tick
 * after the single-leader gate. When breached, the scheduler skips LLM work for all
 * users but still runs non-LLM safety maintenance (reconciliation, breakers, etc.).
 */
export function checkMonthlyLlmSpendCeiling(now: Date = new Date()): MonthlyCeilingResult {
  const ceiling = monthlySpendCeilingUsd();
  if (ceiling === undefined) return { ok: true, totalUsd: 0, ceilingUsd: undefined };
  const totalUsd = totalMonthlyLlmCostUsd(now);
  return { ok: totalUsd < ceiling, totalUsd, ceilingUsd: ceiling };
}
