import { resolveLlmCredential } from "./db";
import { resolveOpenAiModel, type LlmTransport } from "./llm-request";

export type LlmTeamRole = "green" | "red" | "support";
export type LlmModelFamily = "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek";

export interface LlmEndpoint {
  provider: "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek";
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
  if (/^deepseek/i.test(normalized)) return "deepseek";
  return "openai";
}

/**
 * Cross-family default Bear/reviewer model for each Bull family (composite review B/medium/S: "Green
 * and Red resolve to the same model by default ... one greedy same-family Bear surfaces one failure
 * mode"). Picked as a cheap, fast, widely-available model from a DIFFERENT provider than the given
 * family, so an unconfigured `redTeamLlmModel` no longer echoes the Bull's own blind spots. Anthropic
 * Bulls default to a cheap OpenAI reviewer (mirrors the same cross-family intent in the other
 * direction); every non-Anthropic Bull defaults to Claude Haiku (the same model
 * `debateProposal`'s Anthropic path already uses by default).
 */
const CROSS_FAMILY_RED_TEAM_DEFAULT: Record<LlmModelFamily, string> = {
  openai: "claude-haiku-4-5",
  anthropic: "gpt-5.4-mini",
  xai: "claude-haiku-4-5",
  gemini: "claude-haiku-4-5",
  mistral: "claude-haiku-4-5",
  deepseek: "claude-haiku-4-5"
};

/** The default Bear/reviewer model when the policy hasn't set an explicit `redTeamLlmModel`. */
export function defaultCrossFamilyRedTeamModel(bullModel: string | undefined): string {
  return CROSS_FAMILY_RED_TEAM_DEFAULT[llmModelFamily(bullModel)];
}

function resolveRoleModel(
  policy: { llmModel?: string | null; redTeamLlmModel?: string | null } | undefined | null,
  role: LlmTeamRole,
  userId: string
): string {
  const redModel = role === "red" ? policy?.redTeamLlmModel?.trim() : undefined;
  if (redModel) return redModel;
  const bullModel = resolveOpenAiModel(policy);
  if (role !== "red") return bullModel;
  // Cross-family Bear default: only when the owner hasn't set an explicit redTeamLlmModel. Redirect
  // ONLY when a credential for the cross-family model's provider is actually available — an
  // environment/account with just one provider key configured keeps today's same-family fallback
  // (no silent fail-closed routing-to-human-review from defaulting to a provider nobody connected;
  // this app's guardrails are advisory, never a paternalistic default that breaks unconfigured
  // setups). Falls back to the Bull's own model when the cross-family provider has no credential.
  const crossFamilyModel = defaultCrossFamilyRedTeamModel(bullModel);
  const crossFamilyProvider = llmModelFamily(crossFamilyModel);
  const hasCrossFamilyCredential = Boolean(resolveLlmCredential(crossFamilyProvider, userId).key);
  return hasCrossFamilyCredential ? crossFamilyModel : bullModel;
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
  // Each OpenAI call site historically defaulted to either the responses API or
  // chat-completions; pass the site's original default to preserve its transport.
  defaultOpenAiUrl: string = "https://api.openai.com/v1/responses",
  role: LlmTeamRole = "green"
): LlmEndpoint {

  const model = resolveRoleModel(policy, role, userId);

  if (/^claude/i.test(model)) {
    const url =
      process.env.ANTHROPIC_API_URL?.trim() ||
      "https://api.anthropic.com/v1/messages";
    const cred = resolveLlmCredential("anthropic", userId);
    return {
      provider: "anthropic",
      url,
      key: cred.key,
      model,
      keySource: cred.source === "operator" ? "operator" : "user",
      keyRef: cred.keyRef,
      transport: "anthropic-messages"
    };
  }

  if (/^grok/i.test(model)) {
    const url =
      process.env.XAI_API_URL?.trim() ||
      "https://api.x.ai/v1/chat/completions";
    const cred = resolveLlmCredential("xai", userId);
    return {
      provider: "xai",
      url,
      key: cred.key,
      model,
      keySource: cred.source === "operator" ? "operator" : "user",
      keyRef: cred.keyRef,
      transport: "chat-completions"
    };
  }

  if (/^gemini/i.test(model)) {
    const url =
      process.env.GEMINI_API_URL?.trim() ||
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    const cred = resolveLlmCredential("gemini", userId);
    return {
      provider: "gemini",
      url,
      key: cred.key,
      model,
      keySource: cred.source === "operator" ? "operator" : "user",
      keyRef: cred.keyRef,
      transport: "chat-completions"
    };
  }

  if (/^(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)/i.test(model)) {
    const url =
      process.env.MISTRAL_API_URL?.trim() ||
      "https://api.mistral.ai/v1/chat/completions";
    const cred = resolveLlmCredential("mistral", userId);
    return {
      provider: "mistral",
      url,
      key: cred.key,
      model,
      keySource: cred.source === "operator" ? "operator" : "user",
      keyRef: cred.keyRef,
      transport: "chat-completions"
    };
  }

  if (/^deepseek/i.test(model)) {
    const url =
      process.env.DEEPSEEK_API_URL?.trim() ||
      "https://api.deepseek.com/v1/chat/completions";
    const cred = resolveLlmCredential("deepseek", userId);
    return {
      provider: "deepseek",
      url,
      key: cred.key,
      model,
      keySource: cred.source === "operator" ? "operator" : "user",
      keyRef: cred.keyRef,
      transport: "chat-completions"
    };
  }

  // NOTE: Anthropic ("claude*") models are resolved by the correct branch above
  // (provider "anthropic", transport "anthropic-messages"). A previous dead branch here
  // matched /^(claude|anthropic)/ and returned provider:"openai" pointed at the Anthropic
  // /v1/messages endpoint with a chat-completions transport — unreachable (claude is caught
  // above; no model is named "anthropic*") and broken (that endpoint is not OpenAI-compatible).
  // Removed 2026-07-01 (Chat A item 8). All non-matching models fall through to OpenAI below.

  const url = process.env.OPENAI_API_URL?.trim() || defaultOpenAiUrl;
  const cred = resolveLlmCredential("openai", userId);
  const transport: LlmTransport = url.includes("/chat/completions")
    ? "chat-completions"
    : "responses";
  return {
    provider: "openai",
    url,
    key: cred.key,
    model,
    keySource: cred.source === "operator" ? "operator" : "user",
    keyRef: cred.keyRef,
    transport
  };
}
