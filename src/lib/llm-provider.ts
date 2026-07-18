import { resolveLlmCredential } from "./db";
import { resolveOpenAiModel, type LlmTransport } from "./llm-request";

export type LlmTeamRole = "green" | "red" | "support";
export type LlmModelFamily = "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "openrouter";

export interface LlmEndpoint {
  provider: "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "openrouter";
  url: string;
  key?: string;
  model: string;
  keySource: "operator" | "user";
  keyRef?: string;
  transport: LlmTransport;
}

/**
 * The model FAMILY (provider) a model name belongs to, using the same name-prefix rules
 * `resolveLlmEndpoint` uses to pick a wire transport. Exposed so callers (the cross-family Bear
 * default below) can compare families without duplicating the regexes.
 */
export function llmModelFamily(model: string | undefined): LlmModelFamily {
  const normalized = (model ?? "").trim();
  if (/^claude/i.test(normalized)) return "anthropic";
  if (/^grok/i.test(normalized)) return "xai";
  if (/^gemini/i.test(normalized)) return "gemini";
  if (/^(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)/i.test(normalized)) return "mistral";
  if (/^openrouter\//i.test(normalized)) return "openrouter";
  if (/^deepseek/i.test(normalized)) return "deepseek";
  return "openai";
}

/**
 * The credential SERVICE whose key must resolve for a model under universal OpenRouter routing.
 * Production serves EVERY model through the OpenRouter credential (see `resolveLlmEndpoint`), so
 * that's what eligibility/save-gate checks must key on — an OpenRouter-only account must not be
 * rejected for lacking an (unused) native key. Under NODE_ENV=test we key the native family so the
 * existing native-key test fixtures keep resolving. Single source of truth so `resolveLlmEndpoint`,
 * rotation eligibility, and the policy save-gate never drift.
 */
export function modelCredentialService(model: string | undefined): LlmModelFamily {
  return process.env.NODE_ENV === "test" ? llmModelFamily(model) : "openrouter";
}

// Cross-family Red Team DEFAULT removed 2026-07-07 (owner directive: no model is a default for
// anything, ever). The Red Team model is the user's explicit `redTeamLlmModel` or nothing;
// resolveRoleModel returns "" when unset and the caller fails closed. Independence (a different
// model/provider from Green) is the user's choice, nudged by a non-blocking Settings hint, never
// auto-defaulted.

/**
 * Resolve the model for a team role. NO DEFAULTS (owner directive 2026-07-07): the Red Team is the
 * user's explicit `redTeamLlmModel` or "" (unconfigured — the caller MUST fail closed); it NEVER
 * falls back to the Green model or a cross-family default. Green/support resolve to the user's
 * `llmModel` or "".
 */
function resolveRoleModel(
  policy: { llmModel?: string | null; redTeamLlmModel?: string | null } | undefined | null,
  role: LlmTeamRole
): string {
  if (role === "red") return policy?.redTeamLlmModel?.trim() || "";
  return resolveOpenAiModel(policy);
}

/**
 * Provider is derived from the model name (no separate provider flag): claude-* → Anthropic
 * (Messages API), grok-* → xAI (Grok), gemini-* → Google (Gemini), mistral/ministral/codestral/… → Mistral,
 * else OpenAI. xAI/Gemini/Mistral/DeepSeek are all OpenAI-compatible (chat/completions), so those
 * call sites treat them like OpenAI but with a per-provider base URL + key. Anthropic returns its
 * own `anthropic-messages` transport so the shared request builder (`llm-call.ts`) shapes the
 * Messages-API body/headers and forced-tool JSON output. The user selects a provider simply by
 * choosing one of its models — for both the Green (proposal) and Red (review) teams.
 */
export function resolveLlmEndpoint(
  policy?: { llmModel?: string | null; redTeamLlmModel?: string | null } | null,
  userId: string = "local",
  // Preserved for signature compatibility, though OpenRouter always uses chat-completions.
  defaultOpenAiUrl: string = "https://api.openai.com/v1/responses",
  role: LlmTeamRole = "green"
): LlmEndpoint {
  const rawModel = resolveRoleModel(policy, role);
  let model = rawModel;

  // Prefix raw model names with the appropriate OpenRouter provider ID if they don't already have one.
  if (!model.includes("/")) {
    if (/^claude/i.test(model)) {
      model = `anthropic/${model}`;
    } else if (/^grok/i.test(model)) {
      // OpenRouter's Grok namespace is `x-ai/`, not `xai/` — the latter is an invalid model id
      // OpenRouter rejects (Codex finding on PR #1703).
      model = `x-ai/${model}`;
    } else if (/^gemini/i.test(model)) {
      model = `google/${model}`;
    } else if (/^(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)/i.test(model)) {
      model = `mistralai/${model}`;
    } else if (/^deepseek/i.test(model)) {
      model = `deepseek/${model}`;
    } else if (/^(gpt|o1|o3)/i.test(model)) {
      model = `openai/${model}`;
    }
  }

  // Strip a legacy openrouter/ prefix that may have been saved in older policy selections
  // (e.g. "openrouter/google/gemini-2.5-flash" → "google/gemini-2.5-flash").
  model = model.replace(/^openrouter\//i, "");

  const url = process.env.OPENROUTER_API_URL?.trim() || "https://openrouter.ai/api/v1/chat/completions";
  const cred = resolveLlmCredential(modelCredentialService(rawModel), userId);

  return {
    provider: "openrouter",
    url,
    key: cred.key,
    model, // The fully qualified model ID sent to OpenRouter
    keySource: cred.source === "operator" ? "operator" : "user",
    keyRef: cred.keyRef,
    transport: "chat-completions"
  };
}
