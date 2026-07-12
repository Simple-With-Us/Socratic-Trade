// Per-user LLM usage ledger.
//
// Pairs with the operator-funded LLM failover (see `resolveLlmCredential` in db-api-keys.ts):
// when a tenant has no LLM key of their own and falls back to the operator's env key, we record
// who spent and on whose key so the operator can see/attribute cost. Every LLM call records a row
// (the user's own key too) tagged with `keySource` ('user' | 'operator'); token counts are
// best-effort from the provider response (null when the response omits usage).

import crypto from "crypto";
import { getDb } from "./db";
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
  promptTokens?: number;
  completionTokens?: number;
}

export interface LlmTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
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
  const m = model.toLowerCase();
  if (MODEL_PRICE_PER_M[m]) return MODEL_PRICE_PER_M[m];
  // Prefix match (e.g. dated suffixes like claude-haiku-4-5-20251001).
  const hit = Object.keys(MODEL_PRICE_PER_M).find((k) => m.startsWith(k));
  return hit ? MODEL_PRICE_PER_M[hit] : defaultModelPricePerM();
}

/** Best-effort cost in USD. Unpriced models fall back to a conservative default
 *  (env LLM_UNPRICED_MODEL_COST_PER_M as a single USD-per-1M-tokens number, split 50/50
 *  between input/output; default 15 → $7.50/$7.50 per 1M). Returns undefined only when
 *  token counts are both zero/unknown. */
export function estimateLlmCostUsd(model: string | undefined, promptTokens?: number, completionTokens?: number): number | undefined {
  const price = priceForModel(model);
  const inTok = promptTokens ?? 0;
  const outTok = completionTokens ?? 0;
  if (inTok === 0 && outTok === 0) return undefined;
  return (inTok * price[0] + outTok * price[1]) / 1_000_000;
}

/** Normalize OpenAI (chat-completions + responses) and Anthropic usage shapes. */
export function extractLlmUsage(responseJson: unknown): LlmTokenUsage {
  const u = (responseJson as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!u || typeof u !== "object") return {};
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const promptTokens = num(u.prompt_tokens) ?? num(u.input_tokens);
  const completionTokens = num(u.completion_tokens) ?? num(u.output_tokens);
  const totalTokens = num(u.total_tokens) ?? (promptTokens !== undefined || completionTokens !== undefined ? (promptTokens ?? 0) + (completionTokens ?? 0) : undefined);
  return { promptTokens, completionTokens, totalTokens };
}

/** Record one LLM call against a user. Never throws — usage accounting must not break an LLM run. */
export function recordLlmUsage(entry: LlmUsageEntry): void {
  try {
    const total =
      entry.promptTokens !== undefined || entry.completionTokens !== undefined ? (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0) : undefined;
    const cost = estimateLlmCostUsd(entry.model, entry.promptTokens, entry.completionTokens);
    getDb()
      .prepare(
        `INSERT INTO llm_usage (id, user_id, provider, model, context, key_source, key_ref, prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        entry.userId,
        entry.provider,
        entry.model ?? null,
        entry.context ?? "unknown",
        entry.keySource,
        entry.keyRef ?? null,
        entry.promptTokens ?? null,
        entry.completionTokens ?? null,
        total ?? null,
        cost ?? null,
        new Date().toISOString()
      );
    // Fire-and-forget forward to the API Usage Monitor (no-op unless configured; never throws).
    pushLlmUsage({
      provider: entry.provider,
      model: entry.model,
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
export function getLlmUsageSummary(opts: { sinceIso?: string; operatorFundedOnly?: boolean; userId?: string } = {}): LlmUsageRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.sinceIso) {
    where.push("created_at >= ?");
    params.push(opts.sinceIso);
  }
  if (opts.userId) {
    where.push("user_id = ?");
    params.push(opts.userId);
  }
  if (opts.operatorFundedOnly) {
    where.push("key_source = 'operator'");
    where.push("user_id != 'local'");
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(
      `SELECT user_id, provider, model, context, key_source, key_ref,
              COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(total_tokens),0) AS total_tokens,
              COALESCE(SUM(cost_usd),0) AS cost_usd
       FROM llm_usage ${clause}
       GROUP BY user_id, provider, model, context, key_source, key_ref
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
