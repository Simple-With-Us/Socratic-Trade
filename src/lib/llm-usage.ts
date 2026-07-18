// Per-user LLM usage ledger.
//
// Pairs with the operator-funded LLM failover (see `resolveLlmCredential` in db-api-keys.ts):
// when a tenant has no LLM key of their own and falls back to the operator's env key, we record
// who spent and on whose key so the operator can see/attribute cost. Every LLM call records a row
// (the user's own key too) tagged with `keySource` ('user' | 'operator'); token counts are
// best-effort from the provider response (null when the response omits usage).

import crypto from "crypto";
import { audit, getDb } from "./db";
import { apiKeyEnvVarForService, getUserApiKey, keyFingerprint, LOCAL_USER, type LlmKeySource } from "./db-api-keys";
import { pushLlmUsage } from "./usage-monitor-push";
export { keyFingerprint };

export interface LlmUsageEntry {
  userId: string;
  provider: "openai" | "anthropic" | string;
  model?: string;
  /** Where in the app the call originated, e.g. "chat", "strategy", "red-team". */
  context?: string;
  /** 'operator' means the operator-funded env key served this (non-owning) user. */
  keySource: Exclude<LlmKeySource, "none">;
  /** Non-secret stable fingerprint of the API key that served this call (see keyFingerprint), so
   *  usage/cost can be measured PER ATTACHED KEY — user-provided or operator. */
  keyRef?: string;
  /** The connected account this call was recorded for, so cost/tokens can be attributed and
   *  filtered per account (broker/environment derived by joining connected_accounts at read
   *  time). Undefined for account-less contexts (e.g. chat) — those stay "unattributed". */
  connectedAccountId?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** Prompt tokens served from the provider's prompt cache (bill at ~0.1× input). */
  cachedPromptTokens?: number;
  /** Anthropic-only: tokens WRITTEN to the cache this call (bill at ~1.25× input). */
  cacheCreationTokens?: number;
}

export interface LlmTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Prompt tokens served from the provider's prompt cache. OpenAI/Gemini-compat:
   *  usage.prompt_tokens_details.cached_tokens; DeepSeek: usage.prompt_cache_hit_tokens;
   *  Anthropic: usage.cache_read_input_tokens. Subset of promptTokens. */
  cachedPromptTokens?: number;
  /** Anthropic-only: usage.cache_creation_input_tokens (cache-write premium tokens).
   *  Subset of promptTokens (which is normalized to the FULL prompt across providers). */
  cacheCreationTokens?: number;
}

// USD per 1M tokens, [input, output]. Best-effort; unknown models fall back to a
// conservative env-configurable default (LLM_UNPRICED_MODEL_COST_PER_M) so unpriced
// models count against budgets rather than flying under as $0.
const MODEL_PRICE_PER_M: Record<string, [number, number]> = {
  "gpt-4o": [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4.1": [2, 8],
  "gpt-4.1-mini": [0.4, 1.6],
  "o4-mini": [1.1, 4.4],
  "o1-preview": [15, 60],
  "o1-mini": [3, 12],
  "o3-mini": [1.1, 4.4],
  "o1": [15, 60],
  "gpt-5.5": [5, 30],
  "gpt-5.4": [2.5, 15],
  "gpt-5.4-mini": [0.75, 4.5],
  "gpt-5.4-nano": [0.2, 1.25],
  "gpt-5.6": [5, 30],
  "gpt-5.6-sol": [5, 30],
  "gpt-5.6-terra": [2.5, 15],
  "gpt-5.6-luna": [1, 6],
  "grok-build-0.1": [1, 2],
  "grok-4.3": [1.25, 2.5],
  "claude-fable-5": [10, 50],
  "claude-opus-4-8": [5, 25],
  "claude-sonnet-5": [3, 15],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
  // Gemini (lite listed first so the prefix match prefers it over the base flash key).
  "gemini-3.1-flash-lite": [0.25, 1.5],
  "gemini-3.1-pro-preview": [2, 12],
  "gemini-3.5-flash": [1.5, 9],
  "gemini-2.5-flash-lite": [0.1, 0.4],
  "gemini-2.5-flash": [0.3, 2.5],
  "gemini-2.5-pro": [1.25, 10],
  "mistral-large-2512": [2, 6],
  "mistral-medium-3-5": [1.5, 7.5],
  "mistral-small-2603": [0.15, 0.6],
  "mistral-small-2506": [0.1, 0.3],
  "mistral-large": [2, 6],
  "mistral-medium": [0.4, 2],
  "mistral-small": [0.1, 0.3],
  "deepseek-v4-flash": [0.14, 0.28],
  "deepseek-v4-pro": [0.435, 0.87],
  "deepseek-chat": [0.14, 0.28],
  "deepseek-reasoner": [0.14, 0.28]
};

/** Conservative default: $15/1M tokens total ($7.50 input, $7.50 output). Env-configurable. */
function defaultModelPricePerM(): [number, number] {
  const v = Number(process.env.LLM_UNPRICED_MODEL_COST_PER_M);
  const perM = Number.isFinite(v) && v > 0 ? v : 15;
  return [perM / 2, perM / 2];
}

function priceForModel(model: string | undefined): [number, number] {
  if (!model) return defaultModelPricePerM();
  // Strip the full OpenRouter routing prefix so price-table bare IDs match outbound model names.
  // Handles three forms:
  //   "gpt-5.4-mini"                → unchanged
  //   "openai/gpt-5.4-mini"         → "gpt-5.4-mini"  (vendor/model)
  //   "openrouter/openai/gpt-5.4-mini" → "gpt-5.4-mini"  (full 3-part OR prefix)
  // Mirrors stripRoutingPrefix() in app/admin/llm-usage/model-merge.ts.
  let m = model.toLowerCase();
  m = m.replace(/^openrouter\//, ""); // strip leading "openrouter/" if present
  const slashIdx = m.indexOf("/");
  if (slashIdx !== -1) m = m.slice(slashIdx + 1); // strip one vendor segment (e.g. "openai/")
  if (MODEL_PRICE_PER_M[m]) return MODEL_PRICE_PER_M[m];
  // Prefix match (e.g. dated suffixes like claude-haiku-4-5-20251001).
  // Longest-prefix wins so family aliases cannot shadow a more specific tier snapshot
  // (e.g. gpt-5.6 must not price gpt-5.6-terra-* as Sol).
  const hit = Object.keys(MODEL_PRICE_PER_M)
    .sort((left, right) => right.length - left.length)
    .find((k) => m.startsWith(k));
  return hit ? MODEL_PRICE_PER_M[hit] : defaultModelPricePerM();
}

// Cache-read tokens bill at ~0.1× the input rate across providers that report them
// (OpenAI gpt-5.5: $0.50 vs $5.00; Anthropic cache read: 0.1×; DeepSeek cache hit: ~0.1×).
// Anthropic cache WRITES bill at 1.25× input (5-minute ephemeral TTL).
const CACHE_READ_INPUT_MULTIPLIER = 0.1;
const CACHE_WRITE_INPUT_MULTIPLIER = 1.25;

/** Best-effort cost in USD. Unpriced models fall back to a conservative default
 *  (env LLM_UNPRICED_MODEL_COST_PER_M as a single USD-per-1M-tokens number, split 50/50
 *  between input/output; default 15 → $7.50/$7.50 per 1M). Cache-read tokens are priced
 *  at ~0.1× input and Anthropic cache-creation tokens at 1.25× input, so cached calls no
 *  longer overstate cost (previously ALL prompt tokens billed at the full input rate).
 *  Returns undefined only when token counts are both zero/unknown. */
export function estimateLlmCostUsd(
  model: string | undefined,
  promptTokens?: number,
  completionTokens?: number,
  cachedPromptTokens?: number,
  cacheCreationTokens?: number
): number | undefined {
  const price = priceForModel(model);
  const inTok = promptTokens ?? 0;
  const outTok = completionTokens ?? 0;
  if (inTok === 0 && outTok === 0) return undefined;
  // Clamp so malformed provider usage (cached > prompt) can never produce a negative cost.
  const cached = Math.min(Math.max(cachedPromptTokens ?? 0, 0), inTok);
  const creation = Math.min(Math.max(cacheCreationTokens ?? 0, 0), inTok - cached);
  const fullRate = inTok - cached - creation;
  const inputCost = (fullRate + cached * CACHE_READ_INPUT_MULTIPLIER + creation * CACHE_WRITE_INPUT_MULTIPLIER) * price[0];
  return (inputCost + outTok * price[1]) / 1_000_000;
}

/** Normalize OpenAI (chat-completions + responses), Anthropic, DeepSeek, and Gemini-compat
 *  usage shapes, including prompt-cache accounting. `promptTokens` is normalized to the FULL
 *  prompt on every provider: OpenAI/DeepSeek report it that way natively, while Anthropic's
 *  `input_tokens` EXCLUDES cache read/creation tokens — those are added back here. */
export function extractLlmUsage(responseJson: unknown): LlmTokenUsage {
  const u = (responseJson as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!u || typeof u !== "object") return {};
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  // Cache reads: OpenAI/Gemini-compat nest under prompt_tokens_details; DeepSeek and Anthropic are top-level.
  const cachedPromptTokens = num(details.cached_tokens) ?? num(u.prompt_cache_hit_tokens) ?? num(u.cache_read_input_tokens);
  const cacheCreationTokens = num(u.cache_creation_input_tokens);
  const anthropicIn = num(u.input_tokens);
  const promptTokens =
    num(u.prompt_tokens) ??
    // Anthropic: input_tokens excludes cache read/creation — normalize to the full prompt.
    (anthropicIn !== undefined ? anthropicIn + (num(u.cache_read_input_tokens) ?? 0) + (cacheCreationTokens ?? 0) : undefined);
  const completionTokens = num(u.completion_tokens) ?? num(u.output_tokens);
  const totalTokens = num(u.total_tokens) ?? (promptTokens !== undefined || completionTokens !== undefined ? (promptTokens ?? 0) + (completionTokens ?? 0) : undefined);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {})
  };
}

/**
 * Strips the routing prefix (e.g. "openai/") from OpenRouter models to yield the canonical model
 * identity for usage and benchmark persistence, so that historical stats aren't fragmented when
 * routing through OpenRouter.
 */
export function remapOpenRouterTelemetry(provider: string, model: string): { provider: string; model: string };
export function remapOpenRouterTelemetry(provider: string, model: string | undefined): { provider: string; model: string | undefined };
export function remapOpenRouterTelemetry(provider: string, model: string | undefined): { provider: string; model: string | undefined } {
  if (provider === "openrouter" && model) {
    const slashIdx = model.indexOf("/");
    if (slashIdx !== -1) {
      let p = model.slice(0, slashIdx);
      if (p === "google") p = "gemini";
      if (p === "mistralai") p = "mistral";
      if (p === "x-ai") p = "xai";
      return { provider: p, model: model.slice(slashIdx + 1) };
    }
  }
  return { provider, model };
}

/** Record one LLM call against a user. Never throws — usage accounting must not break an LLM run. */
export function recordLlmUsage(entry: LlmUsageEntry): void {
  try {
    const canonical = remapOpenRouterTelemetry(entry.provider, entry.model);
    // Keep the transport route in the ledger and telemetry. OpenRouter is
    // the credential/key namespace that actually served the call; the
    // canonical vendor model is only for pricing and model statistics.
    const provider = entry.provider;
    const model = entry.model;
    const usageId = crypto.randomUUID();
    const occurredAt = new Date().toISOString();
    const total =
      entry.promptTokens !== undefined || entry.completionTokens !== undefined ? (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0) : undefined;
    const cost = estimateLlmCostUsd(canonical.model, entry.promptTokens, entry.completionTokens, entry.cachedPromptTokens, entry.cacheCreationTokens);
    // Prompt-cache visibility (no schema change): when the provider served part of the prompt from
    // cache, write an audit row so cache hit rates + savings are observable per provider/model/context.
    if ((entry.cachedPromptTokens ?? 0) > 0 || (entry.cacheCreationTokens ?? 0) > 0) {
      audit(
        "llm_cache_usage",
        {
          provider,
          model,
          context: entry.context,
          promptTokens: entry.promptTokens,
          cachedPromptTokens: entry.cachedPromptTokens,
          cacheCreationTokens: entry.cacheCreationTokens,
          costUsd: cost
        },
        entry.userId,
        entry.connectedAccountId
      );
    }
    getDb()
      .prepare(
        `INSERT INTO llm_usage (id, user_id, provider, model, context, key_source, key_ref, connected_account_id, prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        usageId,
        entry.userId,
        provider,
        model ?? null,
        entry.context ?? "unknown",
        entry.keySource,
        entry.keyRef ?? null,
        entry.connectedAccountId ?? null,
        entry.promptTokens ?? null,
        entry.completionTokens ?? null,
        total ?? null,
        cost ?? null,
        occurredAt
      );
    // Fire-and-forget forward to the API Usage Monitor (no-op unless configured; never throws).
    pushLlmUsage({
      sourceEventId: usageId,
      occurredAt,
      provider,
      model,
      context: entry.context,
      userId: entry.userId,
      keySource: entry.keySource,
      keyRef: entry.keyRef,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      totalTokens: total,
      costUsd: cost,
    });
  } catch {
    /* ledger is best-effort; never break the caller */
  }
}

export interface LlmUsageRow {
  userId: string;
  provider: string;
  /** LLM model name; null for rows recorded before model tracking. */
  model: string | null;
  /** Where in the app this call originated (chat, strategy, red-team, etc.). */
  context: string | null;
  keySource: LlmKeySource;
  /** Per-attached-key fingerprint (see keyFingerprint); null for legacy rows without one. */
  keyRef: string | null;
  /** Connected account this usage is attributed to; null for unattributed / account-less rows. */
  connectedAccountId: string | null;
  /** Broker of the attributed account (via join to connected_accounts); null when unattributed
   *  or the account has since been deleted. */
  broker: string | null;
  /** 'paper' | 'live' of the attributed account; null when unattributed. */
  environment: string | null;
  /** Human label of the attributed account; null when unattributed. */
  accountLabel: string | null;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

/**
 * Aggregate usage grouped by (userId, provider, keySource, keyRef) — so usage/cost is measured per
 * ATTACHED KEY, not just per source. `sinceIso` bounds the window. `operatorFundedOnly` returns only
 * rows where a NON-`local` tenant spent on the operator key — the figure the operator most cares
 * about while the failover is enabled.
 */
export function getLlmUsageSummary(opts: {
  sinceIso?: string;
  operatorFundedOnly?: boolean;
  userId?: string;
  /** Filter to a single connected account. */
  connectedAccountId?: string;
  /** Filter to a broker (e.g. "alpaca", "robinhood") — matched via join to connected_accounts. */
  broker?: string;
} = {}): LlmUsageRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.sinceIso) {
    where.push("lu.created_at >= ?");
    params.push(opts.sinceIso);
  }
  if (opts.userId) {
    where.push("lu.user_id = ?");
    params.push(opts.userId);
  }
  if (opts.connectedAccountId) {
    where.push("lu.connected_account_id = ?");
    params.push(opts.connectedAccountId);
  }
  if (opts.broker) {
    where.push("ca.broker = ?");
    params.push(opts.broker);
  }
  if (opts.operatorFundedOnly) {
    where.push("lu.key_source = 'operator'");
    where.push("lu.user_id != 'local'");
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // LEFT JOIN so unattributed rows (null connected_account_id) and rows whose account was since
  // deleted still appear (broker/environment/label come back null → "unattributed" in the UI).
  const rows = getDb()
    .prepare(
      `SELECT lu.user_id, lu.provider, lu.model, lu.context, lu.key_source, lu.key_ref,
              lu.connected_account_id,
              ca.broker AS broker, ca.environment AS environment, ca.label AS account_label,
              COUNT(*) AS calls,
              COALESCE(SUM(lu.prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(lu.completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(lu.total_tokens),0) AS total_tokens,
              COALESCE(SUM(lu.cost_usd),0) AS cost_usd
       FROM llm_usage lu
       LEFT JOIN connected_accounts ca ON ca.id = lu.connected_account_id
       ${clause}
       GROUP BY lu.user_id, lu.provider, lu.model, lu.context, lu.key_source, lu.key_ref,
                lu.connected_account_id, ca.broker, ca.environment, ca.label
       ORDER BY cost_usd DESC, calls DESC`
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    userId: String(r.user_id),
    provider: String(r.provider),
    model: r.model == null ? null : String(r.model),
    context: r.context == null ? null : String(r.context),
    keySource: r.key_source as LlmKeySource,
    keyRef: r.key_ref == null ? null : String(r.key_ref),
    connectedAccountId: r.connected_account_id == null ? null : String(r.connected_account_id),
    broker: r.broker == null ? null : String(r.broker),
    environment: r.environment == null ? null : String(r.environment),
    accountLabel: r.account_label == null ? null : String(r.account_label),
    calls: Number(r.calls),
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    totalTokens: Number(r.total_tokens),
    costUsd: Number(r.cost_usd)
  }));
}

export interface KeyDescriptor {
  /** Last 4 chars of the key — a safe display convention (computed at read time, never persisted). */
  last4: string;
  /** Display-safe mask: first 8 chars + "..." + last 4 chars (e.g. "sk-proj-...abcd"). */
  masked: string;
  /** Human label, e.g. "operator (openai)", "u_abc (anthropic)", "operator env (openai)". */
  label: string;
}

/** Produce a display-safe masked representation of a raw API key. */
export function maskApiKey(rawKey: string): string {
  if (rawKey.length <= 12) return `${rawKey.slice(0, 4)}...`;
  return `${rawKey.slice(0, 8)}...${rawKey.slice(-4)}`;
}

/**
 * Resolve a non-secret, human-readable descriptor (last-4 + label) for a usage row's opaque
 * `keyRef`, by matching the fingerprint against the LIVE key stores. Returns undefined once the key
 * is detached — the ledger keeps the fingerprint, but a friendly label is only available while the
 * key is still attached. The last-4 is computed at read time and never stored.
 */
export function describeUsageKey(row: { keyRef: string | null; userId: string; provider: string }): KeyDescriptor | undefined {
  if (!row.keyRef) return undefined;
  // The user's own stored key (for `local` this is the migrated operator key).
  const own = getUserApiKey(row.userId, row.provider)?.apiKey;
  if (own && keyFingerprint(own) === row.keyRef) {
    const label = row.userId === LOCAL_USER ? `primary user (${row.provider})` : `${row.userId} (${row.provider})`;
    return { last4: own.slice(-4), masked: maskApiKey(own), label };
  }
  // The operator's env key (the failover that served a tenant).
  const envVar = apiKeyEnvVarForService(row.provider);
  const envKey = envVar ? process.env[envVar]?.trim() : undefined;
  if (envKey && keyFingerprint(envKey) === row.keyRef) {
    return { last4: envKey.slice(-4), masked: maskApiKey(envKey), label: `server failover (${row.provider})` };
  }
  return undefined;
}
