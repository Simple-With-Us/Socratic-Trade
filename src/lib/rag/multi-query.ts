/**
 * HyDE + evidence-derived multi-query retrieval for the filings RAG pass (hyde-multiquery-retrieval,
 * 2026-07-05). Flag-gated, DEFAULT OFF — every helper here is additive; the existing single-static-
 * query call site in `strategy.ts` is byte-identical when both flags are off.
 *
 * Two flags (both default false, both via `envFlagOn`) — NOT independent, despite the name:
 *   - RAG_MULTIQUERY: derive 2-4 focused facet sub-queries from the candidate's evidence/sector/
 *     regime instead of one generic query. Pure, no I/O — see `deriveQueryVariants`.
 *   - RAG_HYDE: additionally draft 1-3 short hypothetical filing passages via one cheap LLM call
 *     (Hypothetical Document Embeddings) and retrieve using THOSE as queries too — closer to filing
 *     prose than a keyword-ish question, which tends to help dense cosine recall. See
 *     `generateHydePassages`. RAG_HYDE alone is a NO-OP: `strategy.ts` only calls
 *     `generateHydePassages` on the variants `deriveQueryVariants` already produced, inside the
 *     `wantMultiQuery` branch, so RAG_HYDE requires RAG_MULTIQUERY to also be on to have any effect
 *     (there is nothing to draft HyDE passages FROM otherwise). Turning on RAG_HYDE by itself
 *     changes nothing.
 *
 * Both stages degrade to "no variants" on any error/budget condition — retrieval always falls back
 * to the caller's original single query, never throws, never blocks the money path.
 */

import { audit } from "../db";
import { buildLlmRequestBody, extractLlmText, llmAuthHeaders, type LlmJsonSchema } from "../llm-call";
import { isOverLlmBudget } from "../llm-budget";
import { resolveLlmEndpoint } from "../llm-provider";
import { LLM_TIMEOUT_MS } from "../llm-request";
import { recordLlmUsage, extractLlmUsage } from "../llm-usage";
import { getPolicy } from "../db";
import { envFlagOn } from "./env-flag";

/** Returns true when RAG_MULTIQUERY is truthy. Default OFF — single-query retrieval is unaffected. */
export function multiQueryEnabled(): boolean {
  return envFlagOn("RAG_MULTIQUERY", false);
}

/**
 * Returns true when RAG_HYDE is truthy. Default OFF. NOT independent of RAG_MULTIQUERY: the
 * `strategy.ts` call site only drafts HyDE passages from the variants `deriveQueryVariants`
 * produced inside its `wantMultiQuery` branch, so RAG_HYDE=on with RAG_MULTIQUERY off is a no-op
 * (nothing to draft HyDE passages from) — turning on RAG_HYDE alone requires RAG_MULTIQUERY too.
 */
export function hydeEnabled(): boolean {
  return envFlagOn("RAG_HYDE", false);
}

/** Cheap default model for HyDE passage drafting; overridable via RAG_HYDE_MODEL. */
const DEFAULT_HYDE_MODEL = "gpt-5.4-mini";

function hydeModel(): string {
  return process.env.RAG_HYDE_MODEL?.trim() || DEFAULT_HYDE_MODEL;
}

/** Small output cap — 1-3 short hypothetical passages, not a full filing section. */
const HYDE_MAX_OUTPUT_TOKENS = 600;
/** Cap on how many evidence bulletins feed the sub-query text (keeps queries short/focused). */
const MAX_EVIDENCE_BULLETINS = 3;
const MAX_EVIDENCE_CHARS = 140;

export interface QueryVariantInput {
  symbol: string;
  sector?: string;
  dominantFactor?: string;
  /** 1-line evidence bulletins from the scan (congress/insider/technical/etc.), same shape as
   *  `CandidateEvidence.evidenceBulletins` / `SituationCandidate.evidence`. */
  evidenceBulletins?: string[];
  regimeLabel?: string;
  /** Optional short thesis/rationale string, if the caller has one at derivation time. */
  thesis?: string;
}

function compact(value: string, maxChars: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed;
}

/**
 * Derive 2-4 focused facet sub-queries for a candidate symbol from its evidence/sector/regime
 * context. Pure, deterministic, no I/O — safe to call unconditionally (callers gate on
 * `multiQueryEnabled()`). Returns `[]` when there is no usable evidence to derive facets from
 * (i.e. a bare symbol with nothing else) — the caller should fall back to its existing static
 * query rather than retrieve with zero variants.
 *
 * Facets are fixed, filing-shaped angles (risk factors, guidance/earnings, litigation/regulatory,
 * supply-chain/operational) — each phrased as a short natural-language sub-query anchored on the
 * symbol plus whatever contextual hints are available, so the facet queries diverge from each
 * other even when evidence is thin.
 */
export function deriveQueryVariants(input: QueryVariantInput): string[] {
  const symbol = input.symbol?.trim().toUpperCase();
  if (!symbol) return [];

  const hasContext = Boolean(
    input.sector || input.dominantFactor || input.regimeLabel || input.thesis || (input.evidenceBulletins && input.evidenceBulletins.length > 0)
  );
  if (!hasContext) return [];

  const evidence = (input.evidenceBulletins ?? [])
    .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
    .slice(0, MAX_EVIDENCE_BULLETINS)
    .map((line) => compact(line, MAX_EVIDENCE_CHARS));

  const contextParts: string[] = [];
  if (input.sector) contextParts.push(`sector ${input.sector}`);
  if (input.dominantFactor) contextParts.push(`dominant factor ${input.dominantFactor}`);
  if (input.regimeLabel) contextParts.push(`market regime ${input.regimeLabel}`);
  if (input.thesis) contextParts.push(`thesis: ${compact(input.thesis, MAX_EVIDENCE_CHARS)}`);
  const evidenceSuffix = evidence.length > 0 ? ` Recent evidence: ${evidence.join("; ")}.` : "";
  const contextSuffix = contextParts.length > 0 ? ` Context: ${contextParts.join(", ")}.` : "";

  const facets = [
    `${symbol} risk factors and material adverse changes disclosed in recent SEC filings.`,
    `${symbol} management guidance, earnings outlook, and forward-looking statements.`,
    `${symbol} litigation, regulatory, or compliance disclosures.`,
    `${symbol} supply chain, operational, or production disclosures.`
  ];

  // Keep 2-4 facets: always include the first two (risk + guidance are the highest-signal facets
  // for a trading decision), and only add litigation/supply-chain when there's evidence content to
  // anchor them (otherwise they're generic boilerplate that doesn't diverge from the first two).
  const variants = [facets[0]!, facets[1]!];
  if (evidence.length > 0 || input.dominantFactor) {
    variants.push(facets[2]!);
  }
  if (evidence.length > 1) {
    variants.push(facets[3]!);
  }

  return variants.map((facet) => `${facet}${evidenceSuffix}${contextSuffix}`);
}

const HYDE_SCHEMA_DEF: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["passages"],
  properties: {
    passages: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "string", description: "A short (2-4 sentence) hypothetical excerpt written in the style of an SEC filing (10-K/10-Q/8-K) or earnings transcript." }
    }
  }
};

const HYDE_SCHEMA: LlmJsonSchema = {
  name: "hyde_passages",
  schema: HYDE_SCHEMA_DEF,
  description: "Hypothetical filing passages for HyDE-style dense retrieval."
};

const HYDE_SYSTEM_PROMPT = `You draft SHORT hypothetical excerpts (2-4 sentences each) in the style of SEC filings (10-K/10-Q/8-K risk factors, MD&A, or earnings call transcripts) for a given stock and set of sub-topics.

These are NOT real filing text — they are hypothetical passages used purely to improve semantic search recall (Hypothetical Document Embeddings). Write plausible, generic filing-register prose for each sub-topic; do not invent specific numbers, dates, or claims you cannot support from the given context.

Respond ONLY with the structured passages array (1-3 short passages) — no prose, no disclaimers, no markdown fences.`;

interface RawHydeResponse {
  passages?: unknown;
}

function parsePassages(text: string | undefined): string[] {
  if (!text) throw new Error("empty LLM response text");
  const parsed = JSON.parse(text) as RawHydeResponse;
  if (!Array.isArray(parsed.passages)) return [];
  return parsed.passages
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.trim())
    .slice(0, 3);
}

/**
 * Draft 1-3 short hypothetical filing passages (HyDE) for the given sub-queries via ONE cheap LLM
 * call. Fails open — returns `[]` on ANY error (no credential, network error, timeout, non-OK
 * response, malformed JSON) so a HyDE outage never blocks or degrades the underlying retrieval;
 * the caller simply retrieves with fewer/no HyDE variants.
 *
 * Records usage under context "rag-hyde" via `recordLlmUsage` on a successful call (best-effort;
 * a usage-recording failure must not affect the returned passages).
 *
 * Also skips (returns `[]`, no request) when `userId` is over its daily LLM/RAG budget — mirrors
 * `retrieveContextDetailed`'s own `isOverLlmBudget` gate so HyDE's extra LLM call is covered by
 * the same durable spend ceiling as retrieval itself, instead of only the best-effort per-run
 * `shouldDegradeForBudget` check the caller (strategy.ts) already applies.
 */
export async function generateHydePassages(
  queries: string[],
  opts: { userId?: string; connectedAccountId?: string } = {}
): Promise<string[]> {
  const userId = opts.userId ?? "local";
  if (queries.length === 0) return [];
  if (isOverLlmBudget(userId, opts.connectedAccountId)) return [];

  try {
    // Resolve the endpoint FOR the model HyDE actually sends, not the policy's general `llmModel`
    // (2026-07-05 review fix). `resolveLlmEndpoint(policy, ...)` picks provider/URL/key from
    // `policy.llmModel`, but the request body below sends the separately-configured `hydeModel()`
    // (default `gpt-5.4-mini`, overridable via RAG_HYDE_MODEL) — under an Anthropic policy those
    // used to disagree (an OpenAI model id shipped to api.anthropic.com -> 400 -> silently `[]`,
    // with no audit since a non-OK response wasn't audited either). Mirrors how salience-llm.ts
    // stays coherent: it always sends `endpoint.model`, the exact model the endpoint was resolved
    // for. Here HyDE has its own override knob, so we resolve the endpoint for THAT model instead
    // by substituting it into the policy passed to resolveLlmEndpoint — same provider-dispatch
    // rules (claude-*/grok-*/gemini-*/mistral-*/deepseek-* prefixes, else OpenAI), just keyed off
    // the model that will actually be sent.
    const policy = getPolicy(userId);
    const model = hydeModel();
    const endpoint = resolveLlmEndpoint(
      { ...policy, llmModel: model },
      userId,
      "https://api.openai.com/v1/chat/completions",
      "green"
    );
    if (!endpoint.key) return [];

    const userContent = `Sub-topics to draft hypothetical filing passages for:\n${queries.map((q, i) => `${i + 1}. ${q}`).join("\n")}`;

    const body = buildLlmRequestBody(
      { provider: endpoint.provider, transport: endpoint.transport },
      {
        model: endpoint.model,
        systemPrompt: HYDE_SYSTEM_PROMPT,
        userContent,
        schema: HYDE_SCHEMA,
        maxOutputTokens: HYDE_MAX_OUTPUT_TOKENS
      }
    );

    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: llmAuthHeaders({ provider: endpoint.provider, key: endpoint.key }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
    });
    if (!response.ok) {
      try {
        audit("rag_hyde_failed", { reason: `HTTP ${response.status}`, provider: endpoint.provider, model: endpoint.model }, userId);
      } catch {
        // best-effort telemetry only
      }
      return [];
    }

    const payload = await response.json();
    const text = extractLlmText(payload);
    const passages = parsePassages(text); // throws on malformed JSON -> caught below -> []

    try {
      recordLlmUsage({
        userId,
        provider: endpoint.provider,
        model: endpoint.model,
        context: "rag-hyde",
        keySource: endpoint.keySource,
        keyRef: endpoint.keyRef,
        ...extractLlmUsage(payload)
      });
    } catch {
      // best-effort usage accounting only
    }

    return passages;
  } catch (err) {
    console.warn("[rag/multi-query] HyDE generation failed; continuing without HyDE passages:", err instanceof Error ? err.message : String(err));
    try {
      audit("rag_hyde_failed", { reason: err instanceof Error ? err.message : String(err) }, userId);
    } catch {
      // best-effort telemetry only
    }
    return [];
  }
}
