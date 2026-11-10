// Market-open retrieval pressure (SOCRATIC-TRADE-2G).
//
// A strategy wave used to fan out every symbol and every query variant at once.  At the open
// those calls piled onto OpenRouter embed + the vector read, each hit the 15s retrieval
// deadline, and each deadline logged "RAG retrieval failed" (~80/24h).  This gate caps how
// many retrieval provider calls run at once and, after a timeout, refuses new calls until a
// short backoff elapses.  Queued callers still run once a slot frees.  Callers that arrive
// during backoff get a null slot and degrade without another Sentry error.

import { isAbortOrTimeoutError } from "../network-errors";

export const DEFAULT_RAG_RETRIEVAL_CONCURRENCY = 4;
export const DEFAULT_RAG_RETRIEVAL_BACKOFF_BASE_MS = 2_000;
export const DEFAULT_RAG_RETRIEVAL_BACKOFF_MAX_MS = 30_000;

export interface RetrievalSlot {
  release: () => void;
}

interface PressureState {
  inFlight: number;
  consecutiveFailures: number;
  backoffUntil: number;
  /** Bumps on every backoff open.  A success only clears backoff for the epoch it observed. */
  epoch: number;
  waiters: Waiter[];
}

interface Waiter {
  signal?: AbortSignal;
  resolve: (slot: RetrievalSlot | null) => void;
  settled: boolean;
}

const state: PressureState = {
  inFlight: 0,
  consecutiveFailures: 0,
  backoffUntil: 0,
  epoch: 0,
  waiters: []
};

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function retrievalConcurrencyLimit(): number {
  return positiveInt(process.env.RAG_RETRIEVAL_CONCURRENCY, DEFAULT_RAG_RETRIEVAL_CONCURRENCY);
}

function backoffBaseMs(): number {
  return positiveInt(process.env.RAG_RETRIEVAL_BACKOFF_BASE_MS, DEFAULT_RAG_RETRIEVAL_BACKOFF_BASE_MS);
}

function backoffMaxMs(): number {
  return positiveInt(process.env.RAG_RETRIEVAL_BACKOFF_MAX_MS, DEFAULT_RAG_RETRIEVAL_BACKOFF_MAX_MS);
}

/** Off in vitest unless a test opts in, so one timed-out case cannot black-hole the rest of the file. */
export function retrievalBackoffEnabled(): boolean {
  const v = (process.env.RAG_RETRIEVAL_BACKOFF ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  return process.env.NODE_ENV !== "test";
}

export function countsTowardRetrievalBackoff(error: unknown): boolean {
  if (isAbortOrTimeoutError(error)) return true;
  if (error instanceof Error && /timed out|timeout|deadline/i.test(error.message)) return true;
  return false;
}

export function retrievalBackoffRemainingMs(now = Date.now()): number {
  if (!retrievalBackoffEnabled()) return 0;
  return Math.max(0, state.backoffUntil - now);
}

function settle(waiter: Waiter, slot: RetrievalSlot | null): void {
  if (waiter.settled) return;
  waiter.settled = true;
  waiter.resolve(slot);
}

function pump(now = Date.now()): void {
  const limit = retrievalConcurrencyLimit();
  while (state.waiters.length > 0) {
    const waiter = state.waiters[0]!;
    if (waiter.signal?.aborted) {
      state.waiters.shift();
      settle(waiter, null);
      continue;
    }
    if (retrievalBackoffRemainingMs(now) > 0) {
      state.waiters.shift();
      settle(waiter, null);
      continue;
    }
    if (state.inFlight >= limit) return;
    state.waiters.shift();
    state.inFlight += 1;
    settle(waiter, { release: releaseRetrievalSlot });
  }
}

function releaseRetrievalSlot(): void {
  state.inFlight = Math.max(0, state.inFlight - 1);
  pump();
}

/**
 * Take a retrieval provider slot.  `null` means backoff (or the caller already aborted):
 * skip the provider and do not log another retrieval failure.  Otherwise the caller must
 * `release()` exactly once.
 */
export function acquireRetrievalSlot(signal?: AbortSignal, now = Date.now()): Promise<RetrievalSlot | null> {
  if (signal?.aborted) return Promise.resolve(null);
  if (retrievalBackoffRemainingMs(now) > 0) return Promise.resolve(null);
  if (state.inFlight < retrievalConcurrencyLimit() && state.waiters.length === 0) {
    state.inFlight += 1;
    return Promise.resolve({ release: releaseRetrievalSlot });
  }
  return new Promise((resolve) => {
    const waiter: Waiter = { signal, resolve, settled: false };
    if (signal) {
      const onAbort = () => {
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        settle(waiter, null);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const resolveOnce = waiter.resolve;
      waiter.resolve = (slot) => {
        signal.removeEventListener("abort", onAbort);
        resolveOnce(slot);
      };
    }
    state.waiters.push(waiter);
    pump(now);
  });
}

/** Epoch observed when a retrieval slot was taken.  Pass it back to `noteRetrievalPressureSuccess`. */
export function retrievalPressureEpoch(): number {
  return state.epoch;
}

/**
 * Clear backoff after a retrieval that finished cleanly.
 * `seenEpoch` is the epoch from when that call took its slot.  A failure that
 * opened backoff after the call started bumps the epoch, and this success
 * leaves that newer backoff in place.  Omitting `seenEpoch` clears unconditionally.
 */
export function noteRetrievalPressureSuccess(seenEpoch?: number): void {
  if (seenEpoch !== undefined && seenEpoch !== state.epoch) return;
  state.consecutiveFailures = 0;
  state.backoffUntil = 0;
}

export function noteRetrievalPressureFailure(now = Date.now()): void {
  if (!retrievalBackoffEnabled()) return;
  state.epoch += 1;
  state.consecutiveFailures += 1;
  const delay = Math.min(
    backoffMaxMs(),
    backoffBaseMs() * 2 ** Math.max(0, state.consecutiveFailures - 1)
  );
  state.backoffUntil = now + delay;
  const queued = state.waiters.splice(0);
  for (const waiter of queued) settle(waiter, null);
}

export function resetRetrievalPressureForTests(): void {
  state.inFlight = 0;
  state.consecutiveFailures = 0;
  state.backoffUntil = 0;
  state.epoch = 0;
  const queued = state.waiters.splice(0);
  for (const waiter of queued) settle(waiter, null);
}
