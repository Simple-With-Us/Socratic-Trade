import { getActiveConnectedAccount, getPolicy, getStrategyPrompt, resolveLlmCredential } from "./db";
import { deriveExecutionState, llmExecutionMode, llmModeClarification } from "./execution-mode";
import { recordLlmUsage, extractLlmUsage } from "./llm-usage";
import { interactiveStrategyReasoningEffort, LLM_OUTPUT_TOKEN_CAPS, LLM_REQUEST_DEFAULTS, llmFetch } from "./llm-request";
import { resolveLlmEndpoint } from "./llm-provider";
import { buildLlmRequestBody, llmAuthHeaders, extractLlmText } from "./llm-call";
import { humanizeLlmError } from "./llm-errors";
import { withLlmGeneration } from "./observability";
import { STRATEGY_PROMPT_VERSION } from "./strategy-prompt-version";
import { summarizeOpenAiRequest, summarizeOpenAiResponseText } from "./telemetry-sanitize";
import type { MarketQuoteSummary, TradeProposal, TradingPolicy } from "./types";

export interface RedTeamDebateResult {
  rejected: boolean;
  /** True only when the debate actually ran and returned a verdict (vs skipped / failed-open). */
  available: boolean;
  reason: string;
  /** The model that actually served (or attempted) the debate — persisted onto the proposal's
   *  redTeamVerdict for accurate approval-time attribution. Absent when no endpoint was resolved. */
  model?: string;
  /**
   * Structured reason the debate is unavailable (`available: false`), for policy-aware routing
   * ("RED TEAM FAILED" flag) that needs to distinguish failure modes rather than just a free-text
   * reason string. Absent when `available: true` (a verdict was actually returned).
   *  - `not_configured`: no LLM key/credential resolved for the Red Team role.
   *  - `provider_error`: the provider returned a non-2xx response (excluding 429).
   *  - `rate_limited`: the provider returned HTTP 429.
   *  - `timeout`: the request was aborted by the debate's own timeout (or the error otherwise
   *    looks like an abort), as opposed to some other transport failure.
   *  - `malformed_response`: the provider returned a 2xx response but the body was not parseable
   *    JSON, or was parseable JSON that didn't match the required `{rejected: boolean}` shape.
   */
  failureKind?: "not_configured" | "timeout" | "provider_error" | "rate_limited" | "malformed_response";
}

/** True when `error` looks like an AbortSignal.timeout()-triggered abort (vs some other thrown
 *  transport error) — used to classify RedTeamDebateResult.failureKind precisely. */
function isAbortTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError" || /abort|timed?\s*out/i.test(error.message);
}

/**
 * Validate a parsed Red Team verdict body has the required shape. A parseable-but-schema-violating
 * response (missing/non-boolean `rejected`) must NOT silently coerce to an approved verdict — that
 * is the exact fail-open gap this function closes (design doc §4.4). Returns the validated verdict
 * (with `reason` defaulted) or `null` when the shape is invalid.
 */
function validateRedTeamVerdictShape(parsed: unknown): { rejected: boolean; reason: string } | null {
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as { rejected?: unknown; reason?: unknown };
  if (typeof candidate.rejected !== "boolean") return null;
  return { rejected: candidate.rejected, reason: typeof candidate.reason === "string" && candidate.reason ? candidate.reason : "No reason provided." };
}

/** Abort the Red Team LLM call after this long so a hung provider can't wedge the run lock. */
const RED_TEAM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 45_000;

/** Verdict shape the Red Team must return — used as the Anthropic forced-tool schema (Claude red model). */
const RED_TEAM_VERDICT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["rejected", "reason"],
  properties: {
    rejected: { type: "boolean", description: "true if you found a critical flaw, false if approved" },
    reason: { type: "string", description: "your counter-argument or approval reasoning" }
  }
};

/**
 * Which LLM provider runs the Red Team (Bear) debate. Set RED_TEAM_LLM_PROVIDER=anthropic to run the
 * critique on a DIFFERENT model family than the Bull proposer (which uses OpenAI), breaking the
 * single-family "echo chamber" where the Bear shares the Bull's blind spots and concedes too easily.
 * Default "openai" (no behavior change). Falls back to OpenAI if Anthropic is selected but no key is
 * configured, so the (required) debate never silently skips.
 */
export function redTeamProvider(): "openai" | "anthropic" {
  return (process.env.RED_TEAM_LLM_PROVIDER ?? "").trim().toLowerCase() === "anthropic" ? "anthropic" : "openai";
}

export async function debateProposal(
  proposal: TradeProposal,
  quote: MarketQuoteSummary | undefined,
  isBullish: boolean,
  userId: string = "local",
  /**
   * Optional pre-resolved policy to use INSTEAD OF re-reading `getPolicy(userId)`. Lets a caller
   * thread a transient, run-scoped override (e.g. usage-budget's Phase 2 model downgrade, which is
   * applied to an in-memory policy clone and never persisted via `setPolicy`) through to the model
   * this debate actually resolves. Falls back to the persisted policy when omitted — no behavior
   * change for existing callers.
   */
  policyOverride?: TradingPolicy
): Promise<RedTeamDebateResult> {
  const policy = policyOverride ?? getPolicy(userId);
  const executionState = deriveExecutionState(policy, getActiveConnectedAccount(userId));
  const basePrompt = getStrategyPrompt(userId);
  const { url, key: llmKey, model, provider, keySource, keyRef, transport } = resolveLlmEndpoint(policy, userId, "https://api.openai.com/v1/chat/completions", "red");
  
  const systemPrompt = `You are the Red Team Risk Agent. Your job is to rigorously critique the strategy's high-conviction trade proposals.
  
The strategy has proposed to ${proposal.side.toUpperCase()} ${proposal.symbol} with a confidence score of ${proposal.confidenceScore ?? 'N/A'}/100.
Rationale provided: ${proposal.rationale}

Your objective is to play the Devil's Advocate. You must actively search for reasons why this trade will FAIL.
Execution modes are distinct: broker/paper is a broker-hosted sandbox such as Alpaca Paper, and broker/live is a production broker account.
If the proposal is a BUY or COVER (bullish), you are the BEAR. Look for poor fundamentals, bad smart-money signals, or overbought technicals.
If the proposal is a SELL or SHORT (bearish), you are the BULL. Look for strong fundamentals, insider buying, or oversold technicals.

If you find a critical flaw that invalidates the rationale, you MUST REJECT the proposal.
If the rationale is sound and you cannot find a critical flaw, you MUST APPROVE the proposal.

Respond with a JSON object containing:
- rejected: boolean (true if you found a critical flaw, false if approved)
- reason: string (your counter-argument or approval reasoning)`;

  const executionMode = llmExecutionMode(executionState) ?? "no-account";
  const userContent = JSON.stringify({
    proposal,
    quote,
    isBullish,
    policy: {
      executionMode,
      executionModeClarification: llmModeClarification(executionState),
      strategyAuthority: policy.strategyAuthority,
      holdingHorizon: policy.holdingHorizon,
      maxOrderNotional: policy.maxOrderNotional,
      maxDailyNotional: policy.maxDailyNotional,
      scoringWeights: policy.scoringWeights
    },
    strategyPrompt: basePrompt
  });

  // Optional cross-provider Bear: force the critique onto Anthropic (independent of the user's Bull
  // model) so it doesn't share the Bull's structural biases. Falls through to the resolved endpoint
  // above if no Anthropic key is configured, so the (required) debate never silently skips.
  if (redTeamProvider() === "anthropic") {
    const anthropic = resolveLlmCredential("anthropic", userId);
    if (anthropic.key) {
      return debateViaAnthropic({
        apiKey: anthropic.key,
        keySource: anthropic.source === "operator" ? "operator" : "user",
        keyRef: anthropic.keyRef,
        systemPrompt,
        userContent,
        proposal,
        isBullish,
        executionMode,
        userId
      });
    }
  }
  if (!llmKey) return { rejected: false, available: false, reason: "Red Team debate skipped because the LLM is not configured.", failureKind: "not_configured" };

  // OpenAI-compatible providers now request STRICT `json_schema` (the {rejected, reason} verdict
  // shape) so the response is schema-enforced instead of relying on prose + a bare `json_object`.
  // Providers with their own enforcement keep it: DeepSeek (which rejects strict json_schema) falls
  // back to `json_object` inside buildLlmRequestBody, and a Claude Red model enforces the same schema
  // as a forced Anthropic tool. This is the fix for the gemini-3.5-flash unparseable-format incident.
  const body = buildLlmRequestBody(
    { provider, transport },
    {
      model,
      systemPrompt,
      userContent,
      schema: { name: "red_team_verdict", schema: RED_TEAM_VERDICT_SCHEMA, description: "The Red Team's accept/reject verdict." },
      maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.redTeamDebate,
      // Route the required Red Team debate through the SAME interactive-reasoning clamp as the
      // Green/Bear proposal steps (strategy.ts). Without this, a stored gpt-5.5/high config sends
      // high reasoning on the debate call and can hit the very timeout/run-lock this guardrail exists
      // to prevent. (Review: PR #278.)
      reasoningEffort: interactiveStrategyReasoningEffort(model, policy.llmReasoningEffort),
      // Per-role sampling (composite review B/medium/S): the adversary debate runs at a non-zero
      // temperature instead of greedy temp-0 decode, so a re-run can surface a different objection
      // rather than always the identical (or absent) one. Ignored by reasoning models.
      temperature: LLM_REQUEST_DEFAULTS.adversaryTemperature
    }
  );

  try {
    const traced = await withLlmGeneration(
      {
        name: "trading.red-team.debate",
        model,
        userId,
        input: summarizeOpenAiRequest(body),
        metadata: {
          endpoint: url,
          transport,
          symbol: proposal.symbol,
          side: proposal.side,
          isBullish,
          executionMode,
          promptVersion: STRATEGY_PROMPT_VERSION
        },
        tags: ["red-team", "proposal-review"],
        output: (result) => ({
          ...summarizeOpenAiResponseText(result.text),
          rejected: result.debate.rejected,
          reasonChars: result.debate.reason.length
        })
      },
      async (): Promise<{ text: string | undefined; debate: RedTeamDebateResult }> => {
        const response = await llmFetch(url, {
          method: "POST",
          headers: llmAuthHeaders({ provider, key: llmKey }),
          body: JSON.stringify(body),
          // A hung provider would otherwise hold the per-user run lock until the OS socket
          // timeout, starving the scheduler's concurrency slots. Abort and fail closed.
          signal: AbortSignal.timeout(RED_TEAM_TIMEOUT_MS)
        });

        if (!response.ok) {
          const why = humanizeLlmError(await response.text().catch(() => ""), { provider, status: response.status });
          console.warn("Red Team LLM call failed:", why);
          const failureKind: RedTeamDebateResult["failureKind"] = response.status === 429 ? "rate_limited" : "provider_error";
          return {
            text: undefined,
            debate: {
              rejected: false,
              available: false,
              reason: `Red Team debate unavailable — ${why}`,
              model,
              failureKind
            }
          };
        }

        const payload = await response.json();
        recordLlmUsage({ userId, provider, model, context: "red-team", keySource, keyRef, ...extractLlmUsage(payload) });
        const text = extractLlmText(payload);

        if (text) {
          // A parseable-but-schema-violating response (missing/non-boolean `rejected`) must NOT
          // silently coerce to an approved verdict (design doc §4.4) — validate the shape and fail
          // closed (available:false, malformed_response) rather than defaulting via `!!parsed.rejected`.
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch (parseError) {
            console.warn("Red Team response was not valid JSON:", parseError);
            return {
              text,
              debate: {
                rejected: false,
                available: false,
                reason: "Red Team returned an unparseable response (not valid JSON); treating the debate as unavailable.",
                model,
                failureKind: "malformed_response"
              }
            };
          }
          const verdict = validateRedTeamVerdictShape(parsed);
          if (!verdict) {
            return {
              text,
              debate: {
                rejected: false,
                available: false,
                reason: "Red Team returned a malformed verdict (missing/invalid 'rejected'); treating the debate as unavailable.",
                model,
                failureKind: "malformed_response"
              }
            };
          }
          return {
            text,
            debate: { rejected: verdict.rejected, available: true, reason: verdict.reason, model }
          };
        }

        return {
          text: undefined,
          debate: { rejected: false, available: false, reason: "Red Team evaluation returned no response.", model, failureKind: "malformed_response" }
        };
      }
    );
    return traced.debate;
  } catch (error) {
    console.error("Failed to debate proposal:", error);
    return {
      rejected: false,
      available: false,
      reason: "Red Team evaluation errored out.",
      model,
      failureKind: isAbortTimeoutError(error) ? "timeout" : "provider_error"
    };
  }
}

/** Run the Red Team debate on Anthropic's Messages API (cross-provider Bear). Mirrors the OpenAI
 *  path's fail-closed contract: any failure returns available:false so the caller routes to a human. */
async function debateViaAnthropic(args: {
  apiKey: string;
  keySource: "operator" | "user";
  keyRef?: string;
  systemPrompt: string;
  userContent: string;
  proposal: TradeProposal;
  isBullish: boolean;
  executionMode: string;
  userId: string;
}): Promise<RedTeamDebateResult> {
  const model = process.env.RED_TEAM_LLM_MODEL || "claude-haiku-4-5-20251001";
  const body = {
    model,
    max_tokens: LLM_OUTPUT_TOKEN_CAPS.redTeamDebate,
    system: `${args.systemPrompt}\n\nRespond with ONLY the JSON object — no prose, no markdown fences.`,
    messages: [{ role: "user", content: args.userContent }]
  };
  try {
    const traced = await withLlmGeneration(
      {
        name: "trading.red-team.debate",
        model,
        userId: args.userId,
        input: { provider: "anthropic", redTeam: true },
        metadata: {
          endpoint: "https://api.anthropic.com/v1/messages",
          transport: "anthropic-messages",
          symbol: args.proposal.symbol,
          side: args.proposal.side,
          isBullish: args.isBullish,
          executionMode: args.executionMode,
          promptVersion: STRATEGY_PROMPT_VERSION
        },
        tags: ["red-team", "proposal-review", "anthropic"],
        output: (result) => ({ rejected: result.debate.rejected, reasonChars: result.debate.reason.length })
      },
      async (): Promise<{ debate: RedTeamDebateResult }> => {
        const response = await llmFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": args.apiKey,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(RED_TEAM_TIMEOUT_MS)
        });
        if (!response.ok) {
          console.warn("Red Team (Anthropic) call failed", await response.text());
          const failureKind: RedTeamDebateResult["failureKind"] = response.status === 429 ? "rate_limited" : "provider_error";
          return {
            debate: {
              rejected: false,
              available: false,
              reason: "Red Team debate failed to execute.",
              model,
              failureKind
            }
          };
        }
        const payload = await response.json();
        recordLlmUsage({ userId: args.userId, provider: "anthropic", model, context: "red-team", keySource: args.keySource, keyRef: args.keyRef, ...extractLlmUsage(payload) });
        const text: string | undefined = Array.isArray(payload.content)
          ? payload.content.map((c: { text?: string }) => c?.text ?? "").join("")
          : undefined;
        let parsed: unknown = null;
        if (text) {
          try {
            const match = text.match(/\{[\s\S]*\}/);
            if (match) parsed = JSON.parse(match[0]);
          } catch {
            parsed = null;
          }
        }
        // Same shape-validation fail-closed fix as the OpenAI path (design doc §4.4): a
        // parseable-but-schema-violating body (missing/non-boolean `rejected`) must not coerce to
        // an approved verdict via `!!parsed.rejected`.
        const verdict = parsed ? validateRedTeamVerdictShape(parsed) : null;
        if (verdict) {
          return { debate: { rejected: verdict.rejected, available: true, reason: verdict.reason, model } };
        }
        return {
          debate: {
            rejected: false,
            available: false,
            reason: parsed
              ? "Red Team returned a malformed verdict (missing/invalid 'rejected'); treating the debate as unavailable."
              : "Red Team evaluation returned no response.",
            model,
            failureKind: "malformed_response"
          }
        };
      }
    );
    return traced.debate;
  } catch (error) {
    console.error("Failed to debate proposal (Anthropic):", error);
    return {
      rejected: false,
      available: false,
      reason: "Red Team evaluation errored out.",
      model,
      failureKind: isAbortTimeoutError(error) ? "timeout" : "provider_error"
    };
  }
}
