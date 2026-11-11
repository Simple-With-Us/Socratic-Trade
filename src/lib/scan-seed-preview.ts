import type { MarketQuoteSummary, MarketScan } from "./types";

/** Interactive live-recovery budget after a seed snapshot is already on screen. */
export const LIVE_QUOTE_RECOVERY_BUDGET_MS = 35_000;

const CENTRAL_TIME_ZONE = "America/Chicago";
const SENTENCE_GAP = "\u00A0 ";

export type KeptSeedSnapshot = {
  keptSnapshot: true;
  pricesAsOf: string;
  refreshPending: false;
};

export type LiveQuoteRecoveryResult = MarketScan | KeptSeedSnapshot;

export function isKeptSeedSnapshot(value: unknown): value is KeptSeedSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as { keptSnapshot?: unknown; pricesAsOf?: unknown };
  return record.keptSnapshot === true && typeof record.pricesAsOf === "string" && record.pricesAsOf.length > 0;
}

function validStamp(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > now + 5 * 60_000) return undefined;
  return parsed;
}

/**
 * When the saved snapshot was taken. Quote `asOf` wins when any seed row has
 * one. Otherwise the audit timestamp the caller passed as `seedAsOf`.
 */
export function resolveSeedPricesAsOf(
  seed: Record<string, Pick<MarketQuoteSummary, "asOf">> | undefined,
  seedAsOf: string | undefined,
  now = Date.now()
): string | undefined {
  const quoteTimes = Object.values(seed ?? {})
    .map((quote) => validStamp(quote.asOf, now))
    .filter((stamp): stamp is number => stamp !== undefined);
  if (quoteTimes.length > 0) return new Date(Math.max(...quoteTimes)).toISOString();
  const audit = validStamp(seedAsOf, now);
  return audit !== undefined ? new Date(audit).toISOString() : undefined;
}

function agePhrase(minutes: number): string {
  if (minutes < 1) return "under 1 min old";
  if (minutes === 1) return "1 min old";
  if (minutes < 60) return `${minutes} min old`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const hoursLabel = hours === 1 ? "1 hr" : `${hours} hr`;
  if (remainder === 0) return `${hoursLabel} old`;
  return `${hoursLabel} ${remainder} min old`;
}

/** "Prices as of 2:14 PM, 23 min old" in Central time, the market-desk clock. */
export function formatScanPriceAge(pricesAsOf: string, now = Date.now()): string | undefined {
  const then = Date.parse(pricesAsOf);
  if (!Number.isFinite(then)) return undefined;
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: CENTRAL_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(then));
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  return `Prices as of ${clock}, ${agePhrase(minutes)}`;
}

/** Age line for a seed snapshot. While recovery is in flight, say so. */
export function scanSnapshotPriceLabel(input: {
  pricesAsOf?: string;
  refreshPending?: boolean;
  now?: number;
}): string | undefined {
  if (!input.pricesAsOf) return undefined;
  const age = formatScanPriceAge(input.pricesAsOf, input.now ?? Date.now());
  if (!age) return undefined;
  if (input.refreshPending) return `${age}.${SENTENCE_GAP}Updating with live prices.`;
  return age;
}

type RecoveryEntry = {
  userId: string | undefined;
  promise: Promise<LiveQuoteRecoveryResult>;
};

const recoveries = new Map<string, RecoveryEntry>();

export function registerScanRecovery(
  id: string,
  userId: string | undefined,
  promise: Promise<LiveQuoteRecoveryResult>
): void {
  const entry: RecoveryEntry = { userId, promise };
  recoveries.set(id, entry);
  void promise.finally(() => {
    const timer = setTimeout(() => {
      if (recoveries.get(id) === entry) recoveries.delete(id);
    }, 60_000);
    timer.unref?.();
  });
}

export function awaitScanRecovery(
  id: string,
  userId: string | undefined
): Promise<LiveQuoteRecoveryResult> | undefined {
  const entry = recoveries.get(id);
  if (!entry || entry.userId !== userId) return undefined;
  return entry.promise;
}

export function resetScanRecoveriesForTests(): void {
  recoveries.clear();
}
