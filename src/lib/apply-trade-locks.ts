// Evaluate owner-configured per-symbol locks for the current run and persist them.
import { getClosedLotsDetailed } from "./performance";
import { findCoveringTradeLock, getActiveTradeLocks, pruneExpiredTradeLocks, upsertTradeLock, type TradeLockRow } from "./db-trade-locks";
import { evaluateSymbolCooldown, evaluateSymbolLosingStreak, newestCloseAt, type ClosedLotOutcome } from "./trade-locks";
import type { FillSource, TradingPolicy } from "./types";

export function refreshTradeLocksForRun(input: {
  userId: string;
  connectedAccountId: string;
  accountNumber: string;
  policy: TradingPolicy;
  source?: FillSource;
  now?: Date;
}): TradeLockRow[] {
  const now = input.now ?? new Date();
  pruneExpiredTradeLocks(now.toISOString());
  const streakLimit = input.policy.riskRules?.symbolLosingStreakLimit ?? 0;
  const cooldownMinutes = input.policy.riskRules?.symbolCooldownMinutes ?? 0;
  if (streakLimit <= 0 && cooldownMinutes <= 0) {
    return getActiveTradeLocks(input.userId, input.connectedAccountId, now.toISOString());
  }
  const lots = getClosedLotsDetailed(input.accountNumber, input.source, input.userId);
  const bySymbol = new Map<string, ClosedLotOutcome[]>();
  for (const lot of lots) {
    const symbol = (lot.symbol ?? "").trim().toUpperCase();
    if (!symbol) continue;
    const list = bySymbol.get(symbol) ?? [];
    list.push({ symbol, side: lot.side, exitAt: lot.exitAt, returnPct: lot.returnPct });
    bySymbol.set(symbol, list);
  }
  for (const [symbol, symbolLots] of bySymbol) {
    const newestFirst = [...symbolLots].sort((a, b) => Date.parse(b.exitAt ?? "") - Date.parse(a.exitAt ?? ""));
    if (streakLimit > 0) {
      const streak = evaluateSymbolLosingStreak({ outcomes: newestFirst, streakLimit });
      if (streak.firing) {
        upsertTradeLock({
          userId: input.userId,
          connectedAccountId: input.connectedAccountId,
          scope: "symbol",
          symbol,
          side: "*",
          trigger: "symbol_losing_streak",
          reason: streak.reason ?? "symbol losing streak",
          until: new Date(now.getTime() + 24 * 60 * 60_000).toISOString()
        });
      }
    }
    if (cooldownMinutes > 0) {
      const cooldown = evaluateSymbolCooldown({
        lastClosedAt: newestCloseAt(newestFirst),
        cooldownMinutes,
        now: now.getTime()
      });
      if (cooldown.firing) {
        upsertTradeLock({
          userId: input.userId,
          connectedAccountId: input.connectedAccountId,
          scope: "symbol",
          symbol,
          side: "*",
          trigger: "symbol_cooldown",
          reason: cooldown.reason ?? "symbol cooldown",
          until: new Date(now.getTime() + cooldown.remainingMs).toISOString()
        });
      }
    }
  }
  return getActiveTradeLocks(input.userId, input.connectedAccountId, now.toISOString());
}

export function lockForSymbol(locks: TradeLockRow[], symbol: string, side: "long" | "short" | "*" = "*"): TradeLockRow | undefined {
  return findCoveringTradeLock(locks, { symbol, side });
}
