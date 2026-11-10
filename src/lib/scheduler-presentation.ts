import { isRunAllowedNow, nextSessionOpenMs } from "./market-hours";
import { cadenceLaneDecision } from "./triggers";
import type { TradingPolicy } from "./types";

export type PresentedAccountSchedule = {
  lastRunAt: string | null;
  nextRunAt: string | null;
};

/**
 * Dashboard / iOS schedule card.  Last run is the last real strategy start (memory clock, else
 * persisted `strategy_runs`).  Next run is only a scheduled time while autonomy is active —
 * never "not scheduled" for a last-run field, and never blank on Autopilot just because the
 * in-memory cadence clock was empty after a restart or the cash session is closed.
 */
export function presentAccountSchedule(args: {
  memoryLastRunAt?: string | null;
  memoryNextRunAt?: string | null;
  lastStrategyRunStartedAt: string | null;
  systemState: TradingPolicy["systemState"] | string | undefined;
  runCadenceMinutes: number | undefined;
  triggerSettings?: TradingPolicy["triggerSettings"];
  runDuringExtendedHours: boolean;
  now?: Date;
}): PresentedAccountSchedule {
  const now = args.now ?? new Date();
  const lastRunAt = args.memoryLastRunAt ?? args.lastStrategyRunStartedAt;
  const lane = cadenceLaneDecision({
    triggerSettings: args.triggerSettings,
    runCadenceMinutes: args.runCadenceMinutes ?? 60
  });
  const autonomyActive = args.systemState === "active" && lane.run;

  if (!autonomyActive) {
    return { lastRunAt, nextRunAt: null };
  }

  if (args.memoryNextRunAt) {
    return { lastRunAt, nextRunAt: args.memoryNextRunAt };
  }

  const cadenceMs = lane.cadenceMinutes * 60_000;
  let candidateMs = lastRunAt ? new Date(lastRunAt).getTime() + cadenceMs : now.getTime();
  if (!Number.isFinite(candidateMs)) candidateMs = now.getTime();
  if (candidateMs < now.getTime()) candidateMs = now.getTime();

  if (!isRunAllowedNow(args.runDuringExtendedHours, new Date(candidateMs))) {
    candidateMs = nextSessionOpenMs(candidateMs, args.runDuringExtendedHours);
  }

  return { lastRunAt, nextRunAt: new Date(candidateMs).toISOString() };
}
