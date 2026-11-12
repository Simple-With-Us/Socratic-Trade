// Per-credential-lane API circuit breaker.
//
// Providers record health per (service, keySource) lane but nothing GATED calls on it — a dead
// credential got hammered every scan. This breaker sits in front of the network chokepoint
// (fetchWithRetry): when a lane's health says HARD "stopped working" (last 5 non-soft calls all
// failed, per getLaneHealth + HEALTH_REASON_CONSECUTIVE_FAILURES), it short-circuits that specific
// lane for a cool-down window instead of the whole service, then allows ONE half-open probe.
// Soft yellow heuristics ("active this hour but no success") and expected-limit failures (429,
// daily caps) do NOT trip the consecutive-failure hold — matching applyCircuitBreaker.
//
// Paid quote providers (twelvedata, tiingo, marketstack, roic) are the exception. A 429 opens a
// rate-limit hold for Retry-After, or for exponential backoff when that header is absent. A 402
// (out of quota or credit) opens a quota hold for hours. While either hold is open, fetchWithRetry
// throws CircuitOpenError before the network call and does not write a failure health row.
// A user's own bad key trips only ("finnhub","user"); the shared operator lane ("finnhub","env")
// keeps serving. Default ON; disable with API_CIRCUIT_BREAKER_DISABLED=1 (or 0-out
// API_CIRCUIT_BREAKER_BACKOFF_MS to effectively disable the consecutive-failure hold).

import { getLaneHealth, HEALTH_REASON_CONSECUTIVE_FAILURES } from "./db-health";

/** Thrown by fetchWithRetry when a lane's breaker is open. A distinct type so callers can tell a
 *  short-circuit from a real network error (they degrade to the next tier either way). */
export class CircuitOpenError extends Error {
  readonly service: string;
  readonly keySource: string | null;
  constructor(service: string, keySource: string | null, reason?: string | null) {
    super(`API circuit open for ${service} (${keySource ?? "no-key"} lane): ${reason ?? "lane stopped working"}`);
    this.name = "CircuitOpenError";
    this.service = service;
    this.keySource = keySource;
  }
}

export const PAID_QUOTE_PROVIDERS = ["twelvedata", "tiingo", "marketstack", "roic"] as const;
export type PaidQuoteProvider = (typeof PAID_QUOTE_PROVIDERS)[number];

export type CircuitBreakerReason = "rate-limit" | "quota" | "consecutive-failures";

export interface OpenCircuitBreaker {
  service: string;
  keySource: string | null;
  openUntil: string;
  openForMs: number;
  reason: CircuitBreakerReason;
  status: number | null;
}

interface Trip {
  service: string;
  keySource: string | null;
  until: number;
  reason: CircuitBreakerReason;
  status: number | null;
}

// Module-local, per-process: laneKey -> hold. Mirrors the other in-memory caches in this app.
const trippedUntil = new Map<string, Trip>();
const quoteRateStrikes = new Map<string, number>();

const laneKey = (service: string, keySource: string | null): string => `${service}\0${keySource ?? ""}`;

const DEFAULT_402_HOLD_MS = 6 * 60 * 60 * 1000;
const DEFAULT_429_BASE_MS = 1_000;
const DEFAULT_429_CAP_MS = 15 * 60 * 1000;
const DEFAULT_RETRY_AFTER_CAP_MS = 60 * 60 * 1000;

function breakerDisabled(): boolean {
  const v = (process.env.API_CIRCUIT_BREAKER_DISABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

function positiveEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Cool-down after a consecutive-failure trip before a half-open probe is allowed. Env-tunable; default 60s. */
function backoffMs(): number {
  const v = Number(process.env.API_CIRCUIT_BREAKER_BACKOFF_MS ?? 60_000);
  return Number.isFinite(v) && v >= 0 ? v : 60_000;
}

export function isPaidQuoteProvider(service: string | null | undefined): service is PaidQuoteProvider {
  return service != null && (PAID_QUOTE_PROVIDERS as readonly string[]).includes(service);
}

export function quoteProvider402HoldMs(): number {
  return positiveEnvMs("QUOTE_PROVIDER_402_HOLD_MS", DEFAULT_402_HOLD_MS);
}

function quote429BaseMs(): number {
  return positiveEnvMs("QUOTE_PROVIDER_429_BASE_MS", DEFAULT_429_BASE_MS);
}

function quote429CapMs(): number {
  return positiveEnvMs("QUOTE_PROVIDER_429_CAP_MS", DEFAULT_429_CAP_MS);
}

function quoteRetryAfterCapMs(): number {
  return positiveEnvMs("QUOTE_PROVIDER_RETRY_AFTER_CAP_MS", DEFAULT_RETRY_AFTER_CAP_MS);
}

/**
 * Hold length for one paid-quote 429 or 402. 429 with Retry-After uses that delay
 * (capped). 429 without it uses exponential backoff from a per-lane strike count.
 * 402 parks the lane for hours. Success must clear the strike count separately.
 */
export function paidQuoteHoldMs(
  service: string,
  keySource: string | null,
  status: 402 | 429,
  retryAfterMs: number | undefined,
  now = Date.now()
): number {
  if (status === 402) return quoteProvider402HoldMs();
  const key = laneKey(service, keySource);
  // One burst of in-flight 429s is one strike. The next strike waits until
  // this hold has elapsed, so Promise.all cannot jump straight to the cap.
  const cooling = isPaidQuoteBreakerCooling(service, keySource, now);
  let strikes = quoteRateStrikes.get(key) ?? 0;
  if (!cooling) {
    strikes = Math.min(strikes + 1, 16);
    quoteRateStrikes.set(key, strikes);
  }
  const strikeForExp = Math.max(strikes, 1);
  if (retryAfterMs != null && retryAfterMs > 0) {
    return Math.min(retryAfterMs, quoteRetryAfterCapMs());
  }
  const exp = quote429BaseMs() * 2 ** Math.min(strikeForExp - 1, 10);
  return Math.min(exp, quote429CapMs());
}

export function clearPaidQuoteStrikes(service: string, keySource: string | null): void {
  quoteRateStrikes.delete(laneKey(service, keySource));
}

/**
 * True while a paid-quote hold is still cooling. Does not consume the half-open
 * probe and does not consult health. Call this before a local quota reservation
 * so a skip does not burn a credit. The fetch itself still uses
 * apiCircuitBreakerShouldSkip, which is what lets one probe through.
 */
export function isPaidQuoteBreakerCooling(service: string, keySource: string | null, now = Date.now()): boolean {
  if (!isPaidQuoteProvider(service) || breakerDisabled()) return false;
  const trip = trippedUntil.get(laneKey(service, keySource));
  return trip != null && now < trip.until;
}

/** True when this paid-quote lane is in an open hold. Does not consult other services. */
export function paidQuoteBreakerSkip(service: string, keySource: string | null): boolean {
  if (!isPaidQuoteProvider(service)) return false;
  return apiCircuitBreakerShouldSkip(service, keySource).skip;
}

/**
 * Record the outcome of a paid-quote response. 2xx clears the 429 strike count.
 * 429 and 402 open the lane. Other statuses are ignored. Returns the hold in ms.
 */
export function observePaidQuoteStatus(
  service: string,
  keySource: string | null,
  status: number,
  retryAfterMs: number | undefined,
  now = Date.now()
): number {
  if (!isPaidQuoteProvider(service)) return 0;
  if (status >= 200 && status < 300) {
    clearPaidQuoteStrikes(service, keySource);
    return 0;
  }
  if (status !== 402 && status !== 429) return 0;
  const quota = status === 402;
  const hold = paidQuoteHoldMs(service, keySource, quota ? 402 : 429, retryAfterMs, now);
  tripApiCircuitBreakerLane(service, keySource, hold, now, {
    reason: quota ? "quota" : "rate-limit",
    status
  });
  return hold;
}

/**
 * Decide whether to skip a call on this (service, keySource) lane.
 * - Tripped and still cooling down -> skip.
 * - Tripped but cool-down elapsed -> clear the timer and allow ONE half-open probe (its health row
 *   re-evaluates the lane on the next call: a success clears stoppedWorking, a failure re-trips).
 * - Not tripped -> consult getLaneHealth; if the lane stoppedWorking, trip it (set cool-down) and skip.
 */
export function apiCircuitBreakerShouldSkip(
  service: string,
  keySource: string | null
): { skip: boolean; reason?: string | null } {
  if (breakerDisabled()) return { skip: false };
  const key = laneKey(service, keySource);
  const now = Date.now();
  const trip = trippedUntil.get(key);
  if (trip != null) {
    if (now < trip.until) return { skip: true, reason: "circuit-open (lane backed off)" };
    trippedUntil.delete(key); // half-open: let one probe through
    return { skip: false };
  }
  const lane = getLaneHealth(service, keySource);
  // Only the hard 5-consecutive-HARD-failure reason trips the transport breaker. Soft yellow
  // "no success this hour" and expected-limit (429 / daily-cap) streaks must not black out a
  // secondary source (vix-yahoo, nasdaq, RapidAPI) for a full backoff window after one cold fail.
  if (lane.stoppedWorking && lane.reason === HEALTH_REASON_CONSECUTIVE_FAILURES) {
    trippedUntil.set(key, {
      service,
      keySource,
      until: now + backoffMs(),
      reason: "consecutive-failures",
      status: null
    });
    return { skip: true, reason: lane.reason };
  }
  return { skip: false };
}

/** Open holds, soonest expiry first. Empty when nothing is cooling down. */
export function listOpenApiCircuitBreakers(now = Date.now()): OpenCircuitBreaker[] {
  const open: OpenCircuitBreaker[] = [];
  for (const trip of trippedUntil.values()) {
    if (trip.until <= now) continue;
    open.push({
      service: trip.service,
      keySource: trip.keySource,
      openUntil: new Date(trip.until).toISOString(),
      openForMs: trip.until - now,
      reason: trip.reason,
      status: trip.status
    });
  }
  open.sort((a, b) => a.openUntil.localeCompare(b.openUntil) || a.service.localeCompare(b.service));
  return open;
}

/** Test-only: clear all tripped lanes so state doesn't leak across cases. */
export function resetApiCircuitBreaker(): void {
  trippedUntil.clear();
  quoteRateStrikes.clear();
}

/** Hold a lane for an explicit cool-down.  HTTP 429 uses this only after retries are
 *  exhausted and only for a positive Retry-After, except paid quote providers, which
 *  also hold on a header-less 429 (exponential) and on HTTP 402 (hours). */
export function tripApiCircuitBreakerLane(
  service: string,
  keySource: string | null,
  holdMs: number,
  now = Date.now(),
  meta?: { reason?: CircuitBreakerReason; status?: number }
): void {
  if (breakerDisabled() || holdMs <= 0) return;
  const reason = meta?.reason ?? "consecutive-failures";
  const status = meta?.status ?? null;
  const key = laneKey(service, keySource);
  const proposedUntil = now + holdMs;
  const existing = trippedUntil.get(key);
  // A late response must not shorten a hold that is already open. A longer
  // Retry-After or a 402 still extends it.
  if (existing && existing.until > now && proposedUntil <= existing.until) {
    return;
  }
  trippedUntil.set(key, {
    service,
    keySource,
    until: proposedUntil,
    reason,
    status
  });
}
