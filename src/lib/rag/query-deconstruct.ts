import { llmFetch } from "../llm-request";
import { resolveLlmEndpoint } from "../llm-provider";
import { buildLlmRequestBody, extractLlmText, llmAuthHeaders } from "../llm-call";
import { extractLlmUsage, providerRequestIdFromPayload, recordLlmUsage } from "../llm-usage";
import { LLM_OUTPUT_TOKEN_CAPS, LLM_TIMEOUT_MS } from "../llm-request";

const SYSTEM_PROMPT =
  "You are a financial analyst. Decompose a complex search query into 2 to 3 simple, specific sub-queries (each targeted at specific parts of a financial filing, like balance sheets, income statements, or footnotes). Respond ONLY with a JSON object containing a 'queries' array of strings. Example: { \"queries\": [\"subquery 1\", \"subquery 2\"] }";

/**
 * Decomposes a single complex user query into 2-3 specific, targeted sub-queries.
 * Falls back to a heuristic conjunction split on any failure.
 *
 * Metered like every other paid LLM path (usage-compliance WS1 gap #2): the request body is built
 * through `buildLlmRequestBody` (which also injects the OpenRouter classifier enrichment when the
 * endpoint routes there), and each successful response records a `recordLlmUsage` row mirroring
 * `memory/salience-llm.ts` — including the OpenRouter generation id as `providerRequestId`.
 */
export async function deconstructQuery(query: string, userId: string = "local"): Promise<string[]> {
  const originalClean = query.trim();
  if (!originalClean) return [];

  // If query is short, don't decompose it
  const words = originalClean.split(/\s+/);
  if (words.length <= 4) return [originalClean];

  try {
    const policy = { llmModel: "gpt-4o-mini" }; // use default lightweight model
    const endpoint = resolveLlmEndpoint(policy, userId);
    if (!endpoint.key) {
      return fallbackDeconstruct(originalClean);
    }

    const body = buildLlmRequestBody(
      { provider: endpoint.provider, transport: endpoint.transport },
      {
        model: endpoint.model,
        systemPrompt: SYSTEM_PROMPT,
        userContent: `Decompose this query: "${originalClean}"`,
        openAiJsonObject: true,
        maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.queryDeconstruct,
        userId,
        keyRef: endpoint.keyRef,
        service: "rag",
        feature: "rag-query-deconstruct"
      }
    );

    const response = await llmFetch(endpoint.url, {
      method: "POST",
      headers: llmAuthHeaders(endpoint),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
    });

    if (response.ok) {
      const result = await response.json();
      // Usage ledger + external telemetry (owner directive: every paid LLM call is metered).
      // recordLlmUsage never throws, but keep it isolated so accounting can never break retrieval.
      try {
        recordLlmUsage({
          userId,
          provider: endpoint.provider,
          model: endpoint.model,
          context: "rag-query-deconstruct",
          keySource: endpoint.keySource,
          keyRef: endpoint.keyRef,
          providerRequestId: providerRequestIdFromPayload(endpoint.provider, result),
          ...extractLlmUsage(result)
        });
      } catch {
        /* usage ledger is best-effort; never break query deconstruction */
      }
      const text = extractLlmText(result) || "";
      const parsed = JSON.parse(text);
      const queries = Array.isArray(parsed) ? parsed : (parsed.queries || parsed.subQueries || []);
      if (Array.isArray(queries) && queries.length > 0) {
        return queries.map((q: unknown) => String(q).trim()).filter(Boolean);
      }
    }
  } catch (err) {
    console.warn("[query-deconstruct] failed to deconstruct query via LLM; falling back to heuristic:", err);
  }

  return fallbackDeconstruct(originalClean);
}

function fallbackDeconstruct(query: string): string[] {
  const clauses = query.split(/\s+(?:and|or|with|vs|about|regarding)\s+/i);
  const cleanClauses = clauses.map((c) => c.trim()).filter((c) => c.length > 3);
  return cleanClauses.length > 1 ? cleanClauses : [query];
}
