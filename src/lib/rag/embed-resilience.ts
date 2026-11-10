// Fail-fast OpenRouter/SiliconFlow embeddings.
//
// Strategy runs were waiting on hung embed sockets (undici's headers timeout is minutes) and
// then logging an error for every retrieval.  This module gives each attempt a short timeout,
// opens a circuit after N consecutive provider failures, and remembers successful vectors by
// content hash so a repeat query does not call the provider again.
//
// The cache stores only the vector.  Pinecone/Qdrant filters still run on every retrieval.

import { isTransientNetworkError } from "../network-errors";
import { hashContent } from "./chunk";

export const DEFAULT_EMBED_CALL_TIMEOUT_MS = 8_000;
export const DEFAULT_EMBED_BREAKER_FAILURES = 3;
export const DEFAULT_EMBED_BREAKER_COOLDOWN_MS = 60_000;
const DEFAULT_CACHE_MAX = 1024;
const DEFAULT_CACHE_TTL_MS = 30 * 60_000;

export class EmbedCircuitOpenError extends Error {
  readonly provider: string;
  constructor(provider: string) {
    super(`embed circuit open for ${provider}`);
    this.name = "EmbedCircuitOpenError";
    this.provider = provider;
  }
}

export function isEmbedCircuitOpenError(error: unknown): error is EmbedCircuitOpenError {
  return error instanceof EmbedCircuitOpenError
    || (error instanceof Error && error.name === "EmbedCircuitOpenError");
}

function isValidEmbedding(embedding: unknown): embedding is number[] {
  return (
    Array.isArray(embedding) &&
    embedding.length > 0 &&
    embedding.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

/** True when a failed embed attempt should advance the shared provider circuit breaker. */
export function countsTowardEmbedProviderFailure(error: unknown): boolean {
  if (isEmbedCircuitOpenError(error)) return false;
  if (error instanceof Error) {
    if (error.name === "AbortError") return false;
    if (/embed aborted/i.test(error.message)) return false;
  }
  const status = (error as { status?: number }).status;
  if (typeof status === "number") {
    if (status >= 500) return true;
    if (status >= 400 && status < 500) return false;
  }
  if (error instanceof Error) {
    const statusMatch = error.message.match(/\b([45]\d{2})\b/);
    if (statusMatch) {
      const code = Number(statusMatch[1]);
      if (code >= 500) return true;
      if (code >= 400 && code < 500) return false;
    }
    if (error.name === "TimeoutError") return true;
  }
  if (isTransientNetworkError(error)) return true;
  return false;
}

export function embedBreakerEnabled(): boolean {
  const v = (process.env.EMBED_CIRCUIT_BREAKER ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  // Vitest sets NODE_ENV=test.  Leave the breaker off unless a test opts in, so a
  // deliberate failure in one case cannot black-hole later cases in the same file.
  return process.env.NODE_ENV !== "test";
}

export function embedCallTimeoutMs(): number {
  const parsed = Number(process.env.EMBED_CALL_TIMEOUT_MS ?? DEFAULT_EMBED_CALL_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMBED_CALL_TIMEOUT_MS;
}

function breakerFailures(): number {
  const parsed = Number(process.env.EMBED_BREAKER_FAILURES ?? DEFAULT_EMBED_BREAKER_FAILURES);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_EMBED_BREAKER_FAILURES;
}

function breakerCooldownMs(): number {
  const parsed = Number(process.env.EMBED_BREAKER_COOLDOWN_MS ?? DEFAULT_EMBED_BREAKER_COOLDOWN_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMBED_BREAKER_COOLDOWN_MS;
}

interface BreakerState {
  consecutive: number;
  openUntil: number;
  probeInFlight: boolean;
}

const breakers = new Map<string, BreakerState>();

function breakerState(provider: string): BreakerState {
  let state = breakers.get(provider);
  if (!state) {
    state = { consecutive: 0, openUntil: 0, probeInFlight: false };
    breakers.set(provider, state);
  }
  return state;
}

/**
 * True when this call may hit the provider.  A closed breaker always allows the call.
 * An open breaker allows exactly one half-open probe after the cooldown.  Other callers
 * during that probe, and every caller during the cooldown, get false.
 */
export function beginEmbedProviderAttempt(provider: string, now = Date.now()): boolean {
  if (!embedBreakerEnabled()) return true;
  const state = breakerState(provider);
  if (state.openUntil <= 0 || now >= state.openUntil) {
    if (state.openUntil > 0 && now >= state.openUntil) {
      if (state.probeInFlight) return false;
      state.probeInFlight = true;
    }
    return true;
  }
  return false;
}

export function noteEmbedProviderSuccess(provider: string): void {
  if (!embedBreakerEnabled()) return;
  const state = breakerState(provider);
  state.consecutive = 0;
  state.openUntil = 0;
  state.probeInFlight = false;
}

/**
 * End an embed provider attempt: always clears a half-open probe.  Counted failures trip or
 * extend the breaker (the transition into open logs a single warning); non-counted failures
 * (e.g. 4xx) release the probe without wedging.
 */
export function settleEmbedProviderAttempt(provider: string, error?: unknown, now = Date.now()): void {
  if (!embedBreakerEnabled()) return;
  if (!error) {
    breakerState(provider).probeInFlight = false;
    return;
  }
  if (countsTowardEmbedProviderFailure(error)) {
    noteEmbedProviderFailure(provider, now);
    return;
  }
  const state = breakerState(provider);
  const hadProbe = state.probeInFlight;
  state.probeInFlight = false;
  if (hadProbe) {
    // The half-open probe is the breaker's one chance to prove the provider is healthy again,
    // and a 4xx is a client-side rejection, not provider ill-health.  Reset the whole breaker
    // (mirroring noteEmbedProviderSuccess) rather than only clearing openUntil: leaving
    // `consecutive` at its trip value would let the very next counted failure re-trip the
    // breaker and re-log "circuit open" after a single fresh failure.
    state.openUntil = 0;
    state.consecutive = 0;
  }
}

export function noteEmbedProviderFailure(provider: string, now = Date.now()): void {
  if (!embedBreakerEnabled()) return;
  const state = breakerState(provider);
  state.probeInFlight = false;
  state.consecutive += 1;
  if (state.consecutive < breakerFailures()) return;
  const wasAlreadyOpen = state.openUntil > 0;
  state.openUntil = now + breakerCooldownMs();
  if (!wasAlreadyOpen) {
    console.warn(
      `[vector-db] embed circuit open for ${provider} after ${state.consecutive} consecutive failures; cooling down ${breakerCooldownMs()}ms.  Later retrievals skip the provider until the cooldown elapses.`
    );
  }
}

export function isEmbedBreakerOpen(provider: string, now = Date.now()): boolean {
  if (!embedBreakerEnabled()) return false;
  return breakerState(provider).openUntil > now;
}

/**
 * Per-attempt abort.  The caller signal (strategy retrieval deadline) still wins when it
 * fires first.  The timer is unref'd so a finished call cannot keep a test worker alive.
 */
export function createEmbedAttemptAbort(
  caller?: AbortSignal,
  ms: number = embedCallTimeoutMs()
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timeoutError = () => {
    const error = new Error("embed provider timed out");
    error.name = "TimeoutError";
    return error;
  };
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(timeoutError());
  }, ms);
  if (typeof timer.unref === "function") timer.unref();
  const onCallerAbort = () => {
    if (!controller.signal.aborted) {
      const reason = caller?.reason instanceof Error ? caller.reason : timeoutError();
      controller.abort(reason);
    }
  };
  if (caller) {
    if (caller.aborted) onCallerAbort();
    else caller.addEventListener("abort", onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    }
  };
}

interface CacheEntry {
  embedding: number[];
  expiresAt: number;
}

const embeddingCache = new Map<string, CacheEntry>();

function cacheMax(): number {
  const parsed = Number(process.env.EMBED_CONTENT_CACHE_MAX ?? DEFAULT_CACHE_MAX);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_CACHE_MAX;
}

function cacheTtlMs(): number {
  const parsed = Number(process.env.EMBED_CONTENT_CACHE_TTL_MS ?? DEFAULT_CACHE_TTL_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CACHE_TTL_MS;
}

/** Cache key is model + revision + input type + content hash.  The raw text is not stored. */
export function contentEmbeddingCacheKey(
  model: string,
  revision: string | number,
  inputType: string,
  text: string
): string {
  return `${model}\u0000${revision}\u0000${inputType}\u0000${hashContent(text)}`;
}

export function getCachedContentEmbedding(
  model: string,
  revision: string | number,
  inputType: string,
  text: string
): number[] | undefined {
  const key = contentEmbeddingCacheKey(model, revision, inputType, text);
  const entry = embeddingCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    embeddingCache.delete(key);
    return undefined;
  }
  if (!isValidEmbedding(entry.embedding)) {
    embeddingCache.delete(key);
    return undefined;
  }
  embeddingCache.delete(key);
  embeddingCache.set(key, entry);
  return [...entry.embedding];
}

export function setCachedContentEmbedding(
  model: string,
  revision: string | number,
  inputType: string,
  text: string,
  embedding: number[]
): void {
  if (!isValidEmbedding(embedding)) return;
  const key = contentEmbeddingCacheKey(model, revision, inputType, text);
  embeddingCache.delete(key);
  embeddingCache.set(key, { embedding: [...embedding], expiresAt: Date.now() + cacheTtlMs() });
  const limit = cacheMax();
  while (embeddingCache.size > limit) {
    const oldest = embeddingCache.keys().next().value;
    if (oldest === undefined) break;
    embeddingCache.delete(oldest);
  }
}

export function resetEmbedResilienceForTests(): void {
  breakers.clear();
  embeddingCache.clear();
}
