// Cached OpenRouter credit-balance status for /api/health.
//
// WHY: universal OpenRouter routing (#1703) makes OpenRouter the single point of failure for
// every LLM call AND all RAG embedding. When its prepaid credits run out, the whole decision
// loop goes dark (strategy, chat, post-mortems, ingestion) — an incident that already happened
// (see docs/rollouts/2026-07-18-worktree-cleanup-voyage-rca.md). Per owner: no in-app fallback
// and no in-app alerting — instead expose the credit balance on the public /api/health probe so
// an EXTERNAL watchdog (Uptime Robot) can alert when it drops, independently of the app itself.
//
// The `/credits` endpoint is a FREE balance query (no tokens, no LLM cost), and this is cached so
// a frequent health poll never hammers it. `ok` reflects the BALANCE only: a failed check (network
// blip, transient 5xx) never flips ok=false — we fail open (and keep serving the last good value)
// so a monitor doesn't page on our own inability to read the balance, only on genuinely-low money.

import { resolveLlmCredential } from "./db";

const CREDITS_URL = "https://openrouter.ai/api/v1/credits";
// Alert when account prepaid remaining is under this floor (USD). Owner 2026-07-20: $3 is
// "nearly out"; the old $10 default paged while ~a week of ST spend headroom was still left.
// Overridable via OPENROUTER_LOW_CREDIT_USD. Not related to per-key weekly spend limits.
const DEFAULT_THRESHOLD_USD = 3;
const DEFAULT_CACHE_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;

export interface OpenRouterCreditStatus {
  /** false ONLY when the balance was read and is below the threshold — the signal a monitor alerts on. */
  ok: boolean;
  remainingUsd: number | null;
  totalUsd: number | null;
  usedUsd: number | null;
  thresholdUsd: number;
  checkedAt: string;
  /** Present when the balance could not be read this cycle (network/API error); does NOT set ok=false. */
  error?: string;
}

let cache: { status: OpenRouterCreditStatus; atMs: number } | null = null;

function numEnv(name: string, fallback: number, min: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min ? v : fallback;
}
function thresholdUsd(): number {
  return numEnv("OPENROUTER_LOW_CREDIT_USD", DEFAULT_THRESHOLD_USD, 0);
}
function cacheMs(): number {
  return numEnv("OPENROUTER_CREDIT_CHECK_INTERVAL_MS", DEFAULT_CACHE_MS, 30_000);
}

/** Test seam: drop the cached balance so a test controls each fetch. */
export function __resetOpenRouterCreditCache(): void {
  cache = null;
}

/**
 * Cached OpenRouter credit status, or `null` when no OpenRouter key is configured (no signal to
 * publish). Never throws. `fetcher` is injectable for tests.
 */
export async function getOpenRouterCreditStatus(
  nowMs: number = Date.now(),
  fetcher: typeof fetch = fetch,
  options?: { maxWaitMs?: number }
): Promise<OpenRouterCreditStatus | null> {
  // Resolve as the primary operator user: env LLM keys are migrated into `local`'s per-user store
  // at boot, so this is where the production OpenRouter key lives (the no-userId path only resolves
  // when the operator-failover flag is on). Falls back to the no-userId operator path otherwise.
  let key: string | undefined;
  try {
    key = resolveLlmCredential("openrouter", "local").key ?? resolveLlmCredential("openrouter").key;
  } catch {
    key = undefined;
  }
  if (!key) return null;

  if (cache && nowMs - cache.atMs < cacheMs()) return cache.status;

  const threshold = thresholdUsd();
  const checkedAt = new Date(nowMs).toISOString();
  const waitMs = Math.max(200, Math.min(options?.maxWaitMs ?? FETCH_TIMEOUT_MS, FETCH_TIMEOUT_MS));
  try {
    const res = await fetcher(CREDITS_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(waitMs)
    });
    if (!res.ok) {
      // A read failure (401/5xx/etc.) must not masquerade as "low balance". Keep serving the last
      // good value if we have one; otherwise report a fail-open status (ok=true) with the error.
      if (cache) return cache.status;
      return { ok: true, remainingUsd: null, totalUsd: null, usedUsd: null, thresholdUsd: threshold, checkedAt, error: `credits check HTTP ${res.status}` };
    }
    const json = (await res.json()) as { data?: { total_credits?: unknown; total_usage?: unknown } };
    const total = Number(json?.data?.total_credits);
    const used = Number(json?.data?.total_usage);
    if (!Number.isFinite(total) || !Number.isFinite(used)) {
      if (cache) return cache.status;
      return { ok: true, remainingUsd: null, totalUsd: null, usedUsd: null, thresholdUsd: threshold, checkedAt, error: "credits response malformed" };
    }
    const remaining = Math.round((total - used) * 1e6) / 1e6;
    const status: OpenRouterCreditStatus = {
      ok: remaining >= threshold,
      remainingUsd: remaining,
      totalUsd: total,
      usedUsd: used,
      thresholdUsd: threshold,
      checkedAt
    };
    cache = { status, atMs: nowMs };
    return status;
  } catch (error) {
    // Network/timeout: same fail-open policy — never page on our own read failure.
    if (cache) return cache.status;
    return {
      ok: true,
      remainingUsd: null,
      totalUsd: null,
      usedUsd: null,
      thresholdUsd: threshold,
      checkedAt,
      error: error instanceof Error ? error.name : "credits check failed"
    };
  }
}

/**
 * Distinct owner-facing hint when a strategy run failed while the cached OpenRouter credits
 * check is already below threshold.  Empty HTTP-200 bodies are the observed symptom of a
 * near-zero prepaid balance (issue #2577 / 2026-08-06 Green Team session).  Returns undefined
 * unless the balance was actually read and is below the floor — a fail-open read error must
 * never invent a credits cause.
 */
export function formatOpenRouterCreditsExhaustedHint(
  status: OpenRouterCreditStatus | null | undefined
): string | undefined {
  if (!status || status.ok) return undefined;
  if (status.remainingUsd == null || !Number.isFinite(status.remainingUsd)) return undefined;
  const remaining = status.remainingUsd.toFixed(2);
  const floor = status.thresholdUsd.toFixed(2);
  return `OpenRouter credits look exhausted ($${remaining} remaining; alert floor $${floor}).  Empty LLM responses are the usual symptom.  Top up OpenRouter.`;
}

/** Best-effort: read the cached credits check and format a hint.  Never throws. */
export async function maybeOpenRouterCreditsExhaustedHint(
  nowMs: number = Date.now(),
  fetcher: typeof fetch = fetch
): Promise<string | undefined> {
  try {
    return formatOpenRouterCreditsExhaustedHint(await getOpenRouterCreditStatus(nowMs, fetcher));
  } catch {
    return undefined;
  }
}
