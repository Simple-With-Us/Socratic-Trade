import { currentMarketSession } from "./market-hours";

/**
 * Tradier Sandbox answers the order path with HTTP 400 and the sentence
 * "Unexpected server error" when its OMS is briefly wedged.  Production saw
 * that at the cash open (2026-10-13 5:41 / 8:35 / 8:43am CT, 2026-10-14
 * 8:35 / 8:47am CT).  The preview probe treated it as "order path unavailable",
 * which is an immediate auto-halt, and the next healthy probe auto-resumed.
 *
 * The sentence is the classifier.  A real rejection (buying power, bad symbol,
 * PDT, HTTP 403) does not contain it and stays terminal.  A 5xx with the same
 * sentence stays an infrastructure outage and can still halt.
 */
export function isTradierTransientServerError(message: string): boolean {
  const text = String(message ?? "");
  if (!/unexpected\s+server\s+error/i.test(text)) return false;
  if (/\bHTTP\s+5\d\d\b/i.test(text)) return false;
  if (/\bHTTP\s+401\b/i.test(text) || /\bHTTP\s+403\b/i.test(text)) return false;
  return true;
}

/** Preview and place attempts for this one sentence, including the first try. */
export const TRADIER_TRANSIENT_ATTEMPTS = 3;

/** Delay before attempt 2, then before attempt 3.  Kept inside the 30s health probe. */
export const TRADIER_TRANSIENT_BACKOFF_MS = [400, 1200] as const;

export function tradierTransientBackoffMs(attemptIndex: number): number {
  return TRADIER_TRANSIENT_BACKOFF_MS[Math.min(Math.max(0, attemptIndex), TRADIER_TRANSIENT_BACKOFF_MS.length - 1)] ?? 1200;
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thrown when a transient refusal cannot be followed by a tag read.
 * Must not contain "Unexpected server error" or an HTTP 4xx status: those
 * classify as safe-to-retry or as a terminal reject, and either one can
 * drop a live order.  Callers reconcile instead.
 */
export const TRADIER_TAG_LOOKUP_UNVERIFIED_MESSAGE =
  "Tradier order placement unverified: the tag lookup failed. Reconcile before retrying.";

/**
 * Sandbox quotes are 15 minutes delayed, and Tradier orders price off those
 * quotes.  Wait until 16 minutes after the regular open (9:46am ET) so the
 * first tradable print is from after the open.  Live Tradier is not deferred.
 */
export const TRADIER_SANDBOX_OPEN_DEFER_MINUTES = 16;

export const TRADIER_SANDBOX_OPEN_DEFERRAL_MESSAGE =
  "Tradier sandbox quotes are 15 minutes delayed, so strategy runs and order placement wait until 16 minutes after the open (9:46am ET).  Safe to retry.";

export function isTradierSandboxOpenDeferralMessage(message: string): boolean {
  const text = String(message ?? "");
  return /deferred until \d+ minutes after the open/i.test(text) || /wait(?:s)? until \d+ minutes after the open/i.test(text);
}

let nowOverride: (() => Date) | undefined;

/** Test seam.  Production leaves this unset and reads the wall clock. */
export function setTradierNowForTests(fn: (() => Date) | null): void {
  nowOverride = fn ?? undefined;
}

export function tradierNow(): Date {
  return nowOverride ? nowOverride() : new Date();
}

function etMinutesOfDay(now: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "NaN");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "NaN");
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    const normalizedHour = hour === 24 ? 0 : hour;
    return normalizedHour * 60 + minute;
  } catch {
    return null;
  }
}

/**
 * Minutes after the regular US equity open (09:30 ET) while that session is
 * open.  Null before the open, after the close, and on a closed day.
 */
export function minutesSinceRegularOpen(now: Date = tradierNow()): number | null {
  if (currentMarketSession(now) !== "regular") return null;
  const total = etMinutesOfDay(now);
  if (total == null) return null;
  const open = 9 * 60 + 30;
  return total - open;
}

export function isTradierSandboxOpenDeferral(environment: "paper" | "live", now: Date = tradierNow()): boolean {
  if (environment !== "paper") return false;
  const minutes = minutesSinceRegularOpen(now);
  return minutes != null && minutes >= 0 && minutes < TRADIER_SANDBOX_OPEN_DEFER_MINUTES;
}
