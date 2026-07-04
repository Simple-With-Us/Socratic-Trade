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
import type { MarketQuoteSummary, SocraticReversalTrigger, TradeProposal } from "./types";

/**
 * Structured Red Team verdict (2026-07-04 composite review A/B high — "Upgrade the red-team verdict
 * from boolean+prose to structured dissent"). The old shape was `{rejected, reason}`: keyed risks,
 * invalidation triggers, and suggested modifications were UNREPRESENTABLE even though the prompt told
 * the model it may "MODIFY". Both adversary paths (this per-proposal debate AND the inline batch Bear
 * in strategy.ts) now speak this schema. `suggestedChange` is ADVISORY ONLY — it lands as a receipt
 * annotation on the proposal (reviewNotes + redTeamVerdict), never an auto-apply.
 */
export type RedTeamVerdictKind = "approve" | "approve_with_changes" | "reject";

export interface RedTeamSuggestedChange {
  sizeMultiplier?: number;
  stopPrice?: number;
  limitPrice?: number;
}

export interface RedTeamStructuredVerdict {
  verdict: RedTeamVerdictKind;
  keyRisks: string[];
  /** Same `{condition, metric?, level?}` shape as the Bull's reversalTriggers. */
  invalidationTriggers: SocraticReversalTrigger[];
  /** Advisory-only modification suggestion; null when the verdict needs no change. */
  suggestedChange: RedTeamSuggestedChange | null;
  /** What evidence/condition would flip a reject/approve_with_changes to a clean approve. */
  wouldApproveIf?: string;
  /** The Bear's own conviction in its verdict, 1-100. */
  confidence?: number;
  reason: string;
}

export interface RedTeamDebateResult extends Partial<Omit<RedTeamStructuredVerdict, "reason">> {
  rejected: boolean;
  /** True only when the debate actually ran and returned a verdict (vs skipped / failed-open). */
  available: boolean;
  reason: string;
  /** The model that actually served (or attempted) the debate — persisted onto the proposal's
   *  redTeamVerdict for accurate approval-time attribution. Absent when no endpoint was resolved. */
  model?: string;
  /** Token usage of the Bear side of the debate — recorded on the persisted debate transcript. */
  usage?: { promptTokens?: number; completionTokens?: number };
}

/** Abort the Red Team LLM call after this long so a hung provider can't wedge the run lock. */
const RED_TEAM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 45_000;

/** `{condition, metric, level}` trigger object — shared by the debate verdict schema and the inline
 *  Bear's per-survivor verdict + the Bull's reversalTriggers (strategy.ts imports it so the two
 *  adversary paths cannot drift). Strict structured output requires every property listed in
 *  `required`, so optional members are nullable instead. */
export const REVERSAL_TRIGGER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["condition", "metric", "level"],
  properties: {
    condition: { type: "string", description: "Concrete observable condition (one sentence)." },
    metric: { type: ["string", "null"], description: "The metric to watch when statable (e.g. 'VIX', 'price', 'hyCreditSpread')." },
    level: { type: ["number", "null"], description: "The trigger level on that metric when statable." }
  }
};

/** Advisory-only suggested modification. NEVER auto-applied — it becomes a receipt annotation. */
export const RED_TEAM_SUGGESTED_CHANGE_SCHEMA: Record<string, unknown> = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["sizeMultiplier", "stopPrice", "limitPrice"],
      properties: {
        sizeMultiplier: { type: ["number", "null"], description: "Multiply the advised size by this (e.g. 0.5 = halve it). Null if no size change." },
        stopPrice: { type: ["number", "null"], description: "Suggested stop price. Null if no stop change." },
        limitPrice: { type: ["number", "null"], description: "Suggested limit price. Null if no limit change." }
      }
    },
    { type: "null" }
  ]
};

/** Verdict shape the Red Team must return — schema-enforced on OpenAI-compatible providers and used
 *  as the Anthropic forced-tool shape (Claude red model). Upgraded 2026-07-05 from `{rejected, reason}`
 *  to full structured dissent; exported so tests can assert both adversary paths carry the same fields. */
export const RED_TEAM_VERDICT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "keyRisks", "invalidationTriggers", "suggestedChange", "wouldApproveIf", "confidence", "reason"],
  properties: {
    verdict: {
      enum: ["approve", "approve_with_changes", "reject"],
      description:
        "reject = critical flaw found; approve_with_changes = acceptable but suggestedChange should be considered (ADVISORY — a human/agent decides); approve = sound as proposed."
    },
    keyRisks: {
      type: "array",
      maxItems: 6,
      items: { type: "string" },
      description: "The keyed risks that most threaten this trade, most severe first."
    },
    invalidationTriggers: {
      type: "array",
      maxItems: 5,
      items: REVERSAL_TRIGGER_SCHEMA,
      description: "Concrete conditions that would invalidate the trade thesis; include metric+level where statable."
    },
    suggestedChange: RED_TEAM_SUGGESTED_CHANGE_SCHEMA,
    wouldApproveIf: {
      type: ["string", "null"],
      description: "For reject/approve_with_changes: what evidence or condition would earn a clean approve. Null on a clean approve."
    },
    confidence: { type: ["number", "null"], description: "Your conviction in this verdict, 1-100." },
    reason: { type: "string", description: "Your counter-argument or approval reasoning." }
  }
};

/** Raw parsed verdict payload — the new structured shape, with the legacy `{rejected}` boolean
 *  tolerated so a sloppy model emission still resolves to a usable verdict instead of fail-open. */
type RawVerdictPayload = Partial<RedTeamStructuredVerdict> & { rejected?: boolean };

/** Normalize a parsed verdict payload into the structured result fields. Exported for tests. */
export function normalizeRedTeamVerdict(parsed: RawVerdictPayload, model?: string): Omit<RedTeamDebateResult, "usage"> {
  const verdict: RedTeamVerdictKind | undefined =
    parsed.verdict === "approve" || parsed.verdict === "approve_with_changes" || parsed.verdict === "reject"
      ? parsed.verdict
      : parsed.rejected === true
        ? "reject"
        : parsed.rejected === false
          ? "approve"
          : undefined;
  if (!verdict) {
    return { rejected: false, available: false, reason: "Red Team verdict was missing/unrecognized.", model };
  }
  const keyRisks = Array.isArray(parsed.keyRisks) ? parsed.keyRisks.filter((r): r is string => typeof r === "string" && r.trim().length > 0).slice(0, 6) : [];
  const invalidationTriggers = Array.isArray(parsed.invalidationTriggers)
    ? parsed.invalidationTriggers
        .filter((t): t is SocraticReversalTrigger => !!t && typeof t === "object" && typeof (t as SocraticReversalTrigger).condition === "string")
        .map((t) => ({
          condition: t.condition,
          ...(typeof t.metric === "string" && t.metric ? { metric: t.metric } : {}),
          ...(typeof t.level === "number" && Number.isFinite(t.level) ? { level: t.level } : {})
        }))
        .slice(0, 5)
    : [];
  const rawChange = parsed.suggestedChange;
  const suggestedChange: RedTeamSuggestedChange | null =
    rawChange && typeof rawChange === "object"
      ? {
          ...(typeof rawChange.sizeMultiplier === "number" && Number.isFinite(rawChange.sizeMultiplier) ? { sizeMultiplier: rawChange.sizeMultiplier } : {}),
          ...(typeof rawChange.stopPrice === "number" && Number.isFinite(rawChange.stopPrice) ? { stopPrice: rawChange.stopPrice } : {}),
          ...(typeof rawChange.limitPrice === "number" && Number.isFinite(rawChange.limitPrice) ? { limitPrice: rawChange.limitPrice } : {})
        }
      : null;
  return {
    rejected: verdict === "reject",
    available: true,
    reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason : "No reason provided.",
    model,
    verdict,
    keyRisks,
    invalidationTriggers,
    suggestedChange: suggestedChange && Object.keys(suggestedChange).length > 0 ? suggestedChange : null,
    ...(typeof parsed.wouldApproveIf === "string" && parsed.wouldApproveIf.trim() ? { wouldApproveIf: parsed.wouldApproveIf } : {}),
    ...(typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? { confidence: Math.max(1, Math.min(100, parsed.confidence)) }
      : {})
  };
}

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
  userId: string = "local"
): Promise<RedTeamDebateResult> {
  const policy = getPolicy(userId);
  const executionState = deriveExecutionState(policy, getActiveConnectedAccount(userId));
  const basePrompt = getStrategyPrompt(userId);
  const { url, key: llmKey, model, provider, keySource, keyRef, transport } = resolveLlmEndpoint(policy, userId, "https://api.openai.com/v1/chat/completions", "red");

  const systemPrompt = `You are the Red Team Risk Agent. Your job is to rigorously critique the strategy's high-conviction trade proposals.

The strategy has proposed to ${proposal.side.toUpperCase()} ${proposal.symbol} with a confidence score of ${proposal.confidenceScore ?? 'N/A'}/100.
Rationale provided: ${proposal.rationale}
${proposal.belief ? `Stated belief: ${proposal.belief}` : ""}
${proposal.strongestCounterRead ? `The proposer's own strongest counter-read (attack it or sharpen it): ${proposal.strongestCounterRead}` : ""}

Your objective is to play the Devil's Advocate. You must actively search for reasons why this trade will FAIL.
Execution modes are distinct: broker/paper is a broker-hosted sandbox such as Alpaca Paper, and broker/live is a production broker account.
If the proposal is a BUY or COVER (bullish), you are the BEAR. Look for poor fundamentals, bad smart-money signals, or overbought technicals.
If the proposal is a SELL or SHORT (bearish), you are the BULL. Look for strong fundamentals, insider buying, or oversold technicals.

Return a STRUCTURED verdict:
- verdict: "reject" when you found a critical flaw that invalidates the rationale; "approve_with_changes" when the trade is acceptable but needs a tighter stop, better limit, or smaller size (put the concrete numbers in suggestedChange — it is ADVISORY, a receipt for the owner, never auto-applied); "approve" when the rationale is sound and you cannot find a critical flaw.
- keyRisks: the specific risks that most threaten this trade, most severe first.
- invalidationTriggers: concrete conditions that would invalidate the thesis, with metric+level where statable (e.g. condition "VIX spikes above 25", metric "VIX", level 25).
- suggestedChange: {sizeMultiplier, stopPrice, limitPrice} or null.
- wouldApproveIf: what would earn a clean approve (null on a clean approve).
- confidence: your conviction in this verdict, 1-100.
- reason: your counter-argument or approval reasoning.`;

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
  if (!llmKey) return { rejected: false, available: false, reason: "Red Team debate skipped because the LLM is not configured." };

  // OpenAI-compatible providers request STRICT `json_schema` (the structured verdict shape) so the
  // response is schema-enforced instead of relying on prose + a bare `json_object`. Providers with
  // their own enforcement keep it: DeepSeek (which rejects strict json_schema) falls back to
  // `json_object` inside buildLlmRequestBody, and a Claude Red model enforces the same schema as a
  // forced Anthropic tool. This is the fix for the gemini-3.5-flash unparseable-format incident.
  const body = buildLlmRequestBody(
    { provider, transport },
    {
      model,
      systemPrompt,
      userContent,
      schema: { name: "red_team_verdict", schema: RED_TEAM_VERDICT_SCHEMA, description: "The Red Team's structured verdict." },
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
          ...(result.debate.verdict ? { verdict: result.debate.verdict } : {}),
          reasonChars: result.debate.reason.length
        })
      },
      async () => {
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
          return {
            text: undefined,
            debate: { rejected: false, available: false, reason: `Red Team debate unavailable — ${why}`, model } as RedTeamDebateResult
          };
        }

        const payload = await response.json();
        const usage = extractLlmUsage(payload);
        recordLlmUsage({ userId, provider, model, context: "red-team", keySource, keyRef, ...usage });
        const text = extractLlmText(payload);

        if (text) {
          const parsed = JSON.parse(text) as RawVerdictPayload;
          return {
            text,
            debate: {
              ...normalizeRedTeamVerdict(parsed, model),
              usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }
            } as RedTeamDebateResult
          };
        }

        return {
          text: undefined,
          debate: { rejected: false, available: false, reason: "Red Team evaluation returned no response.", model } as RedTeamDebateResult
        };
      }
    );
    return traced.debate;
  } catch (error) {
    console.error("Failed to debate proposal:", error);
  }

  return { rejected: false, available: false, reason: "Red Team evaluation errored out.", model };
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
        output: (result) => ({
          rejected: result.debate.rejected,
          ...(result.debate.verdict ? { verdict: result.debate.verdict } : {}),
          reasonChars: result.debate.reason.length
        })
      },
      async () => {
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
          return { debate: { rejected: false, available: false, reason: "Red Team debate failed to execute.", model } as RedTeamDebateResult };
        }
        const payload = await response.json();
        const usage = extractLlmUsage(payload);
        recordLlmUsage({ userId: args.userId, provider: "anthropic", model, context: "red-team", keySource: args.keySource, keyRef: args.keyRef, ...usage });
        const text: string | undefined = Array.isArray(payload.content)
          ? payload.content.map((c: { text?: string }) => c?.text ?? "").join("")
          : undefined;
        let parsed: RawVerdictPayload | null = null;
        if (text) {
          try {
            const match = text.match(/\{[\s\S]*\}/);
            if (match) parsed = JSON.parse(match[0]) as RawVerdictPayload;
          } catch {
            parsed = null;
          }
        }
        if (parsed) {
          const normalized = normalizeRedTeamVerdict(parsed, model);
          return {
            debate: {
              ...normalized,
              ...(normalized.available ? { usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens } } : {})
            } as RedTeamDebateResult
          };
        }
        return { debate: { rejected: false, available: false, reason: "Red Team evaluation returned no response.", model } as RedTeamDebateResult };
      }
    );
    return traced.debate;
  } catch (error) {
    console.error("Failed to debate proposal (Anthropic):", error);
    return { rejected: false, available: false, reason: "Red Team evaluation errored out.", model };
  }
}
