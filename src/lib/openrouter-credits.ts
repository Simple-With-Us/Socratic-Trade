// Cached OpenRouter credit + per-key limit status for /api/health.
//
// WHY: universal OpenRouter routing (#1703) makes OpenRouter the single point of failure for
// every LLM call AND all RAG embedding. When prepaid credits run out — or when an individual
// key hits its spend limit — the decision loop goes dark (strategy, chat, post-mortems,
// ingestion). Per owner: no in-app fallback and no in-app alerting — instead expose a boolean
// on the public /api/health probe so an EXTERNAL watchdog (Uptime Robot) can alert
// independently of the app itself.
//
// Redesign (2026-08-09): prefer an OpenRouter **Management** key (`OPENROUTER_MANAGEMENT_KEY`
// or `OPENROUTER_ADMIN_KEY`) so we can read:
//   1. Account prepaid balance via free GET /credits (total_credits − total_usage)
//   2. Every key's spend limit via GET /keys (limit_remaining) — alert when any enabled key
//      has its limit reached or is low
// Inference keys still get account /credits when a management key is absent (fail soft).
//
// `ok` reflects REAL money/limit state only: a failed check (network/5xx/401) never flips
// ok=false — we fail open (and keep serving the last good value) so a monitor doesn't page on
// our own inability to read the balance. Cached so a frequent health poll never hammers OR.

import { resolveLlmCredential } from "./db";

const CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const KEY_URL = "https://openrouter.ai/api/v1/key";
const KEYS_URL = "https://openrouter.ai/api/v1/keys";

// Alert when account prepaid remaining is under this floor (USD). Owner 2026-07-20: $3 is
// "nearly out". Overridable via OPENROUTER_LOW_CREDIT_USD.
const DEFAULT_THRESHOLD_USD = 3;
// Per-key spend-limit floor (USD remaining). Default matches account floor; set to 0 to only
// alert when a key is fully exhausted (limit_remaining <= 0). Keys with no limit set are ignored.
const DEFAULT_KEY_LIMIT_THRESHOLD_USD = 3;
const DEFAULT_CACHE_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const KEYS_PAGE_SIZE = 100;
const MAX_KEYS_PAGES = 50;

export type OpenRouterCreditReason =
  | "account_low"
  | "key_limit_reached"
  | "key_limit_low";

export interface OpenRouterCreditStatus {
  /** false ONLY when balance/limits were read and a real low/exhausted condition is present. */
  ok: boolean;
  remainingUsd: number | null;
  totalUsd: number | null;
  usedUsd: number | null;
  thresholdUsd: number;
  /** Floor applied to each key's limit_remaining (USD). */
  keyLimitThresholdUsd: number;
  checkedAt: string;
  /** Which credential tier powered this check. */
  source: "management" | "inference";
  /** True when /keys was successfully read this cycle (or from cache). */
  keysChecked: boolean;
  keysWithLimit: number;
  keysLimitReached: number;
  keysLimitLow: number;
  /** Compact reason codes for operators (non-secret). Empty when ok. */
  reasons: OpenRouterCreditReason[];
  /** Present when the balance could not be read this cycle; does NOT set ok=false. */
  error?: string;
  /** Operator-only: redacted key labels that tripped a limit condition. */
  problemKeyLabels?: string[];
}

let cache: { status: OpenRouterCreditStatus; atMs: number } | null = null;

function numEnv(name: string, fallback: number, min: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min ? v : fallback;
}
function thresholdUsd(): number {
  return numEnv("OPENROUTER_LOW_CREDIT_USD", DEFAULT_THRESHOLD_USD, 0);
}
function keyLimitThresholdUsd(): number {
  return numEnv("OPENROUTER_KEY_LIMIT_LOW_USD", DEFAULT_KEY_LIMIT_THRESHOLD_USD, 0);
}
function cacheMs(): number {
  return numEnv("OPENROUTER_CREDIT_CHECK_INTERVAL_MS", DEFAULT_CACHE_MS, 30_000);
}

/** Test seam: drop the cached balance so a test controls each fetch. */
export function __resetOpenRouterCreditCache(): void {
  cache = null;
}

function resolveCheckKey(): string | undefined {
  // Prefer an explicit management/admin key so /keys is available. These must live in the
  // app's Infisical project (not only ~/.secrets handoff) for production.
  for (const name of ["OPENROUTER_MANAGEMENT_KEY", "OPENROUTER_ADMIN_KEY"] as const) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  try {
    return resolveLlmCredential("openrouter", "local").key ?? resolveLlmCredential("openrouter").key;
  } catch {
    return undefined;
  }
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

interface KeyLimitRow {
  label: string | null;
  disabled: boolean;
  limitUsd: number | null;
  limitRemainingUsd: number | null;
}

async function fetchJson(
  url: string,
  key: string,
  fetcher: typeof fetch,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetcher(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

async function detectManagementKey(
  key: string,
  fetcher: typeof fetch,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<boolean> {
  try {
    const res = await fetchJson(KEY_URL, key, fetcher, timeoutMs);
    if (!res.ok || !res.data || typeof res.data !== "object") return false;
    const data = (res.data as { data?: Record<string, unknown> }).data;
    if (!data || typeof data !== "object") return false;
    return data.is_management_key === true || data.is_provisioning_key === true;
  } catch {
    return false;
  }
}

async function fetchAllKeys(
  key: string,
  fetcher: typeof fetch,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<{ ok: boolean; status: number; keys: KeyLimitRow[] }> {
  const keys: KeyLimitRow[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_KEYS_PAGES; page += 1) {
    const url = new URL(KEYS_URL);
    url.searchParams.set("include_disabled", "true");
    url.searchParams.set("offset", String(offset));
    const res = await fetchJson(url.toString(), key, fetcher, timeoutMs);
    if (!res.ok) {
      return { ok: false, status: res.status, keys: [] };
    }
    const rows =
      res.data && typeof res.data === "object" && !Array.isArray(res.data)
        ? (res.data as { data?: unknown }).data
        : null;
    if (!Array.isArray(rows)) {
      return { ok: false, status: 502, keys: [] };
    }
    for (const raw of rows) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      keys.push({
        label:
          typeof row.label === "string"
            ? row.label
            : typeof row.name === "string"
              ? row.name
              : null,
        disabled: row.disabled === true,
        limitUsd: parseNumber(row.limit),
        limitRemainingUsd: parseNumber(row.limit_remaining)
      });
    }
    if (rows.length < KEYS_PAGE_SIZE) {
      return { ok: true, status: res.status, keys };
    }
    offset += rows.length;
  }
  return { ok: false, status: 502, keys: [] };
}

function evaluateKeyLimits(
  keys: KeyLimitRow[],
  keyFloor: number
): {
  keysWithLimit: number;
  keysLimitReached: number;
  keysLimitLow: number;
  reasons: OpenRouterCreditReason[];
  problemKeyLabels: string[];
} {
  let keysWithLimit = 0;
  let keysLimitReached = 0;
  let keysLimitLow = 0;
  const reasons = new Set<OpenRouterCreditReason>();
  const problemKeyLabels: string[] = [];

  for (const k of keys) {
    if (k.disabled) continue;
    // Only keys with an explicit spend cap participate in limit alerts.
    if (k.limitUsd == null && k.limitRemainingUsd == null) continue;
    if (k.limitRemainingUsd == null) continue;
    keysWithLimit += 1;
    const rem = k.limitRemainingUsd;
    if (rem <= 0) {
      keysLimitReached += 1;
      reasons.add("key_limit_reached");
      if (k.label && problemKeyLabels.length < 8) problemKeyLabels.push(k.label);
    } else if (rem < keyFloor) {
      keysLimitLow += 1;
      reasons.add("key_limit_low");
      if (k.label && problemKeyLabels.length < 8) problemKeyLabels.push(k.label);
    }
  }

  return {
    keysWithLimit,
    keysLimitReached,
    keysLimitLow,
    reasons: [...reasons],
    problemKeyLabels
  };
}

/**
 * Cached OpenRouter credit + key-limit status, or `null` when no key is configured (no signal).
 * Never throws. `fetcher` is injectable for tests.
 */
export async function getOpenRouterCreditStatus(
  nowMs: number = Date.now(),
  fetcher: typeof fetch = fetch,
  options?: { maxWaitMs?: number }
): Promise<OpenRouterCreditStatus | null> {
  const key = resolveCheckKey();
  if (!key) return null;

  if (cache && nowMs - cache.atMs < cacheMs()) return cache.status;

  const accountThreshold = thresholdUsd();
  const keyFloor = keyLimitThresholdUsd();
  const checkedAt = new Date(nowMs).toISOString();
  const waitMs = Math.max(200, Math.min(options?.maxWaitMs ?? FETCH_TIMEOUT_MS, FETCH_TIMEOUT_MS));

  const failOpen = (error: string): OpenRouterCreditStatus => {
    if (cache) return cache.status;
    return {
      ok: true,
      remainingUsd: null,
      totalUsd: null,
      usedUsd: null,
      thresholdUsd: accountThreshold,
      keyLimitThresholdUsd: keyFloor,
      checkedAt,
      source: "inference",
      keysChecked: false,
      keysWithLimit: 0,
      keysLimitReached: 0,
      keysLimitLow: 0,
      reasons: [],
      error
    };
  };

  try {
    const isManagement = await detectManagementKey(key, fetcher, waitMs);
    const source: "management" | "inference" = isManagement ? "management" : "inference";

    // Account prepaid balance (free). Works with management keys; many inference keys also
    // answer /credits — if it fails we fail-open rather than page.
    const creditsRes = await fetchJson(CREDITS_URL, key, fetcher, waitMs);
    if (!creditsRes.ok) {
      return failOpen(`credits check HTTP ${creditsRes.status}`);
    }
    const creditsPayload =
      creditsRes.data && typeof creditsRes.data === "object" && !Array.isArray(creditsRes.data)
        ? (creditsRes.data as { data?: { total_credits?: unknown; total_usage?: unknown } }).data
        : undefined;
    const total = parseNumber(creditsPayload?.total_credits);
    const used = parseNumber(creditsPayload?.total_usage);
    if (total == null || used == null) {
      return failOpen("credits response malformed");
    }
    const remaining = Math.round((total - used) * 1e6) / 1e6;

    let keysChecked = false;
    let keysWithLimit = 0;
    let keysLimitReached = 0;
    let keysLimitLow = 0;
    let keyReasons: OpenRouterCreditReason[] = [];
    let problemKeyLabels: string[] = [];
    let keysError: string | undefined;

    if (isManagement) {
      const keysResult = await fetchAllKeys(key, fetcher, waitMs);
      if (keysResult.ok) {
        keysChecked = true;
        const evald = evaluateKeyLimits(keysResult.keys, keyFloor);
        keysWithLimit = evald.keysWithLimit;
        keysLimitReached = evald.keysLimitReached;
        keysLimitLow = evald.keysLimitLow;
        keyReasons = evald.reasons;
        problemKeyLabels = evald.problemKeyLabels;
      } else {
        // Keys read failed: still report account balance; do not page solely for this.
        keysError = `keys check HTTP ${keysResult.status}`;
      }
    }

    const reasons: OpenRouterCreditReason[] = [...keyReasons];
    if (remaining < accountThreshold) {
      reasons.push("account_low");
    }

    // A transient keys-read failure must not erase a known key-limit failure (Sentry, PR #5097):
    // when this run could not check keys at all — management detection failed or the /keys read
    // errored — and the previous cached status was failing on key limits, retain the cached key
    // reasons, counts and labels instead of caching a fresh ok:true that flaps the alert off.
    // The account-balance fields above still refresh; only the key-limit verdict is carried over,
    // and the next successful /keys read replaces it.
    if (!keysChecked && cache) {
      const cachedKeyReasons = cache.status.reasons.filter(
        (reason) => reason === "key_limit_reached" || reason === "key_limit_low"
      );
      if (cachedKeyReasons.length) {
        for (const reason of cachedKeyReasons) {
          if (!reasons.includes(reason)) reasons.push(reason);
        }
        keysWithLimit = cache.status.keysWithLimit;
        keysLimitReached = cache.status.keysLimitReached;
        keysLimitLow = cache.status.keysLimitLow;
        if (cache.status.problemKeyLabels?.length) {
          problemKeyLabels = cache.status.problemKeyLabels;
        }
      }
    }

    const status: OpenRouterCreditStatus = {
      ok: reasons.length === 0,
      remainingUsd: remaining,
      totalUsd: total,
      usedUsd: used,
      thresholdUsd: accountThreshold,
      keyLimitThresholdUsd: keyFloor,
      checkedAt,
      source,
      keysChecked,
      keysWithLimit,
      keysLimitReached,
      keysLimitLow,
      reasons,
      ...(keysError ? { error: keysError } : {}),
      ...(problemKeyLabels.length ? { problemKeyLabels } : {})
    };
    cache = { status, atMs: nowMs };
    return status;
  } catch (error) {
    return failOpen(error instanceof Error ? error.name : "credits check failed");
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
