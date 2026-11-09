import { envFlagOn, type EnvSource } from "./env-flag";

export type RagRerankProvider = "openrouter" | "siliconflow";
export type RerankIntent = "scout" | "deep" | "exact" | "general";

export interface RerankRouteInput {
  embeddingProvider: RagRerankProvider;
  configuredProvider?: string;
  hasCredential: (provider: RagRerankProvider) => boolean;
  env?: EnvSource;
}

export interface RerankRoute {
  provider: RagRerankProvider;
  model: string;
  available: boolean;
  source: "explicit" | "embedding-provider";
  reason?: "missing_credential" | "invalid_configuration";
}

export interface RerankPlanInput {
  query: string;
  limit: number;
  availableCandidates: number;
  enabled: boolean;
  adaptiveEnabled?: boolean;
  intent?: RerankIntent;
  exactLexicalHit?: boolean;
  topScoreGap?: number;
  env?: EnvSource;
}

export interface RerankPlan {
  shouldRerank: boolean;
  intent: RerankIntent;
  candidateLimit: number;
  reason: "disabled" | "insufficient_candidates" | "legacy_depth" | "adaptive_depth";
}

const DEFAULT_MODEL: Record<RagRerankProvider, string> = {
  openrouter: "cohere/rerank-v3.5",
  siliconflow: "Qwen/Qwen3-Reranker-8B"
};

const DEFAULT_DEPTH: Record<RerankIntent, number> = {
  scout: 40,
  deep: 150,
  exact: 30,
  general: 80
};

const DEPTH_ENV: Record<RerankIntent, string> = {
  scout: "VECTOR_RERANK_SCOUT_OVERFETCH_K",
  deep: "VECTOR_RERANK_DEEP_OVERFETCH_K",
  exact: "VECTOR_RERANK_EXACT_OVERFETCH_K",
  general: "VECTOR_RERANK_GENERAL_OVERFETCH_K"
};

function parseProvider(value: string | undefined): RagRerankProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "openrouter" || normalized === "siliconflow") return normalized;
  throw new Error(`RAG_RERANK_PROVIDER must be "openrouter" or "siliconflow"; received ${JSON.stringify(value)}`);
}

function modelFor(provider: RagRerankProvider, env: EnvSource): string {
  const configured = provider === "openrouter" ? env.OPENROUTER_RERANK_MODEL : env.SILICONFLOW_RERANK_MODEL;
  return configured?.trim() || DEFAULT_MODEL[provider];
}

/**
 * Resolve reranking independently from embedding. An explicit route never silently falls back to
 * another provider when its credential is absent: the retrieval pipeline can truthfully record the
 * unavailable route and retain its deterministic cosine/fusion order.
 *
 * Invalid explicit provider names are also non-fatal: rerank is an optional quality stage, so a
 * typo must not abort dense/lexical recall. The receipt marks the route unavailable instead.
 */
export function resolveRerankRoute(input: RerankRouteInput): RerankRoute {
  const env = input.env ?? process.env;
  const configuredProvider = input.configuredProvider ?? env.RAG_RERANK_PROVIDER;
  let explicit: RagRerankProvider | undefined;
  try {
    explicit = parseProvider(configuredProvider);
  } catch {
    const provider = input.embeddingProvider;
    return {
      provider,
      model: modelFor(provider, env),
      available: false,
      source: "explicit",
      reason: "invalid_configuration"
    };
  }
  const provider = explicit ?? input.embeddingProvider;
  const available = input.hasCredential(provider);
  return {
    provider,
    model: modelFor(provider, env),
    available,
    source: explicit ? "explicit" : "embedding-provider",
    ...(!available ? { reason: "missing_credential" as const } : {})
  };
}

export function adaptiveRerankEnabled(env: EnvSource = process.env): boolean {
  return envFlagOn("RAG_ADAPTIVE_RERANK", true, env);
}

function positiveWhole(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function looksExact(query: string): boolean {
  const normalized = query.trim();
  return (
    /\b\d{10}-\d{2}-\d{6}\b/.test(normalized) ||
    /\b(?:10-k|10-q|8-k|20-f|40-f)\b/i.test(normalized) ||
    /\bitem\s+\d+(?:\.\d+)?[a-z]?\b/i.test(normalized) ||
    /"[^"\n]{3,}"/.test(normalized)
  );
}

export function classifyRerankIntent(query: string, limit: number, exactLexicalHit = false): RerankIntent {
  if (exactLexicalHit || looksExact(query)) return "exact";
  if (limit <= 1) return "scout";
  if (limit >= 8) return "deep";
  return "general";
}

/**
 * Choose a bounded candidate depth without changing verdict semantics. Adaptive mode adjusts how
 * many candidates reach the cross-encoder; it does not skip reranking based on an uncalibrated score
 * gap. Invalid env tuning fails open to reviewed defaults.
 */
export function planRerank(input: RerankPlanInput): RerankPlan {
  const available = Math.max(0, Math.floor(input.availableCandidates));
  const intent = input.intent ?? classifyRerankIntent(input.query, input.limit, input.exactLexicalHit);
  if (!input.enabled) return { shouldRerank: false, intent, candidateLimit: 0, reason: "disabled" };
  if (available <= 1) {
    return { shouldRerank: false, intent, candidateLimit: available, reason: "insufficient_candidates" };
  }

  const env = input.env ?? process.env;
  const adaptive = input.adaptiveEnabled ?? adaptiveRerankEnabled(env);
  const requested = adaptive
    ? positiveWhole(env[DEPTH_ENV[intent]], DEFAULT_DEPTH[intent])
    : positiveWhole(env.VECTOR_RERANK_OVERFETCH_K, 150);
  const candidateLimit = Math.min(available, Math.max(input.limit, requested));
  return {
    shouldRerank: true,
    intent,
    candidateLimit,
    reason: adaptive ? "adaptive_depth" : "legacy_depth"
  };
}
