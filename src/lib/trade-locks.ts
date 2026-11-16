// Composable trade-history circuit breakers (freqtrade PairLocks port).
//
// Pure evaluators only — no DB. Independently-configurable triggers write scoped,
// expiring, reason-carrying locks that policy.ts treats as overridable-by-default
// (same autonomyOverride bucket as the wash-sale non-IRA case). Every threshold is
// an owner preference; unset/<=0 disables that trigger.

export type TradeLockScope = "account" | "symbol";
export type TradeLockSide = "long" | "short" | "*";
export type TradeLockTrigger = "symbol_losing_streak" | "symbol_cooldown";

export interface ClosedLotOutcome {
  symbol?: string;
  side?: "long" | "short";
  /** ISO timestamp of the close. */
  exitAt?: string;
  /** Realized return % (signed). */
  returnPct?: number;
}

export interface LosingStreakEvaluation {
  firing: boolean;
  consecutiveLossStreak: number;
  reason?: string;
}

export interface CooldownEvaluation {
  firing: boolean;
  remainingMs: number;
  reason?: string;
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function isLoss(lot: ClosedLotOutcome): boolean {
  return typeof lot.returnPct === "number" && Number.isFinite(lot.returnPct) && lot.returnPct < 0;
}

/** Newest-first consecutive losses on one symbol. Flat/win breaks the streak. */
export function evaluateSymbolLosingStreak(input: {
  /** Closed lots for ONE symbol, newest first. */
  outcomes: ClosedLotOutcome[];
  streakLimit?: number;
}): LosingStreakEvaluation {
  const streakLimit = clampInt(input.streakLimit, 1, 100);
  let consecutiveLossStreak = 0;
  for (const lot of input.outcomes) {
    if (isLoss(lot)) consecutiveLossStreak += 1;
    else break;
  }
  if (!streakLimit || consecutiveLossStreak < streakLimit) {
    return { firing: false, consecutiveLossStreak };
  }
  return {
    firing: true,
    consecutiveLossStreak,
    reason: `last ${consecutiveLossStreak} closed trade${consecutiveLossStreak === 1 ? "" : "s"} on this symbol lost`
  };
}

/** Unconditional per-symbol post-close cooldown. */
export function evaluateSymbolCooldown(input: {
  lastClosedAt?: string;
  cooldownMinutes?: number;
  now?: number;
}): CooldownEvaluation {
  const cooldownMinutes = clampInt(input.cooldownMinutes, 1, 60 * 24 * 30);
  if (!cooldownMinutes) return { firing: false, remainingMs: 0 };
  if (typeof input.lastClosedAt !== "string" || !input.lastClosedAt) {
    return { firing: false, remainingMs: 0 };
  }
  const closedMs = Date.parse(input.lastClosedAt);
  if (!Number.isFinite(closedMs)) return { firing: false, remainingMs: 0 };
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  const untilMs = closedMs + cooldownMinutes * 60_000;
  const remainingMs = untilMs - now;
  if (remainingMs <= 0) return { firing: false, remainingMs: 0 };
  return {
    firing: true,
    remainingMs,
    reason: `symbol cooldown ${cooldownMinutes}m after last close (${Math.ceil(remainingMs / 60_000)}m remaining)`
  };
}

export function newestCloseAt(lots: ClosedLotOutcome[]): string | undefined {
  let best: { iso: string; ms: number } | undefined;
  for (const lot of lots) {
    if (typeof lot.exitAt !== "string" || !lot.exitAt) continue;
    const ms = Date.parse(lot.exitAt);
    if (!Number.isFinite(ms)) continue;
    if (!best || ms > best.ms) best = { iso: lot.exitAt, ms };
  }
  return best?.iso;
}

/** True when a stored lock covers a proposed (symbol, side) query. */
export function lockCoversQuery(
  lock: { scope: TradeLockScope; symbol?: string | null; side: TradeLockSide },
  query: { symbol: string; side: TradeLockSide }
): boolean {
  if (lock.side !== "*" && query.side !== "*" && lock.side !== query.side) return false;
  if (lock.scope === "account") return true;
  const lockSymbol = typeof lock.symbol === "string" ? lock.symbol.trim().toUpperCase() : "";
  return lockSymbol !== "" && lockSymbol === query.symbol.trim().toUpperCase();
}
