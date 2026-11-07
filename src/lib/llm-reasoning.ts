/** Pure model/reasoning helpers. Safe in client components; no credential or fetch imports. */
import { nativeSlugFor } from "./llm-model-catalog";
import type { LlmReasoningEffort } from "./types";

/** OpenAI and OpenAI-compatible (xAI/Gemini/Mistral/DeepSeek) HTTP shapes. */
export type OpenAiTransport = "responses" | "chat-completions";
/** "rotation" is a UI-ONLY pseudo-provider for the "__rotate__" seat sentinel (see
 *  ROTATION_UI_REASONING_CAPABILITY) — no wire-shaping branch may ever match it. */
export type LlmReasoningProvider = "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "minimax" | "meta" | "rotation";

export interface LlmReasoningOption {
  value: LlmReasoningEffort;
  label: string;
  hint: string;
}

export interface LlmReasoningCapability {
  provider: LlmReasoningProvider;
  label: string;
  settingLabel: string;
  description: string;
  options: LlmReasoningOption[];
}

/**
 * Every LLM wire transport the app speaks. Anthropic's Messages API ("anthropic-messages") is NOT
 * OpenAI-compatible (top-level `system`, `max_tokens`, `x-api-key` header, content-block responses,
 * forced tool-use for structured JSON), so it is modelled as its own transport rather than folded
 * into the OpenAI-compatible pair. See `llm-call.ts` for the per-transport request/response shaping.
 */
export type LlmTransport = OpenAiTransport | "anthropic-messages";

// DEFAULT_OPENAI_MODEL removed 2026-07-07 (owner directive: no model is a default for anything,
// ever). Strategy Green/Red resolve to explicit per-user choices ("" when unset → fail closed);
// the chat assistant requires an explicit per-request model or CHAT_LLM_MODEL (no hardcoded model).

/**
 * Sentinel model id meaning "rotate through every eligible curated model, a different one each
 * run" (owner comparative-measurement option for accruing attributed history across models). It is a valid
 * PERSISTED value for policy.llmModel / policy.redTeamLlmModel, but it must never be SERVED:
 * `runStrategyOnce` substitutes the concrete pick onto its run-scoped policy clone at the top of
 * every run (src/lib/model-rotation.ts) before any endpoint resolution. Defined here (leaf module,
 * no imports beyond types) so both the rotation module and `resolveOpenAiModel`'s safety net below
 * can share it without an import cycle. Keep the literal in sync with the UI copy in
 * app/ui/llm-model-catalog.ts (ROTATE_ALL_MODELS_ID).
 */
export const LLM_MODEL_ROTATION_SENTINEL = "__rotate__";

/** True when the model id is the rotation sentinel (see LLM_MODEL_ROTATION_SENTINEL). */
export function isModelRotationSentinel(model?: string | null): boolean {
  return (model ?? "").trim() === LLM_MODEL_ROTATION_SENTINEL;
}

/**
 * OpenAI "reasoning" models (gpt-5/6 families, o-series). They REJECT the `temperature` param
 * (400 "Only the default (1) value is supported") and instead take `reasoning_effort`. They also
 * spend output budget on hidden reasoning tokens, so the visible-output cap must be raised.
 */
export function isReasoningModel(model: string | undefined): boolean {
  const leaf = lowerModel(model);
  const native = nativeSlugFor(model).toLowerCase();
  return /^(gpt-[56]|o\d)/i.test(leaf) || /^(gpt-[56]|o\d)/i.test(native);
}

/**
 * Resolve the per-user Green (strategist/proposer) model. NO DEFAULT — owner directive
 * (2026-07-07): no model is a default for anything, ever. Both the Green (`llmModel`) and Red
 * (`redTeamLlmModel`) team models must be explicitly chosen in Settings, and it is enforced
 * impossible to save a policy without them (app/api/policy/route.ts). Returns "" when unchosen;
 * callers MUST treat "" as unconfigured and fail closed (route to human / skip the run), never
 * send an empty-model request. The former `OPENAI_MODEL`-env and `DEFAULT_OPENAI_MODEL` strategy
 * fallbacks are deliberately removed.
 *
 * The rotation sentinel ("__rotate__") is ALSO treated as unset here — a SAFETY NET for consumers
 * that read the persisted policy directly OUTSIDE a strategy run (chat, the outcome-engine lesson
 * pass, strategy tuning, the run route's key precheck): with no defaults left it resolves to ""
 * (fail closed) instead of sending the literal "__rotate__" to a provider. The strategy run itself
 * substitutes the concrete rotation pick before ever reaching this function
 * (src/lib/model-rotation.ts).
 */
export function resolveOpenAiModel(policy?: { llmModel?: string | null } | null): string {
  const fromPolicy = policy?.llmModel?.trim();
  if (fromPolicy && fromPolicy !== LLM_MODEL_ROTATION_SENTINEL) return fromPolicy;
  return "";
}

export const ALL_LLM_REASONING_EFFORTS: readonly LlmReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const REASONING_OPTION_BY_VALUE: Record<LlmReasoningEffort, LlmReasoningOption> = {
  none: { value: "none", label: "None", hint: "Disable provider-side thinking where that provider allows it." },
  minimal: { value: "minimal", label: "Minimal", hint: "Smallest supported thinking budget above off." },
  low: { value: "low", label: "Low", hint: "Lower latency and cost; less deliberate analysis." },
  medium: { value: "medium", label: "Medium", hint: "Balanced depth, latency, and cost." },
  high: { value: "high", label: "High", hint: "Deeper analysis with higher latency and token use." },
  xhigh: { value: "xhigh", label: "XHigh", hint: "Extra-high provider thinking budget where supported." },
  max: { value: "max", label: "Max", hint: "Provider maximum thinking budget where supported." }
};

function options(values: readonly LlmReasoningEffort[]): LlmReasoningOption[] {
  return values.map((value) => REASONING_OPTION_BY_VALUE[value]);
}

export function lowerModel(model: string | undefined): string {
  let name = (model ?? "").trim().toLowerCase();
  // Strip provider prefixes for capability matching (e.g. anthropic/claude-3 -> claude-3)
  if (name.includes("/")) {
    name = name.split("/").pop() || name;
  }
  return name;
}

function isAnthropicAdaptiveThinkingModel(model: string | undefined): boolean {
  const normalized = lowerModel(model);
  return (
    /^claude-fable-5(?:$|[-.:_])/.test(normalized) ||
    /^claude-mythos-5(?:$|[-.:_])/.test(normalized) ||
    /^claude-opus-(?:5(?:\.5|-5)?|4-(?:6|7|8))(?:$|[-.:_])/.test(normalized) ||
    /^claude-sonnet-(?:5|4-6)(?:$|[-.:_])/.test(normalized) ||
    // Haiku 5.5 (native claude-haiku-5-5): adaptive thinking, on by default, and any non-default
    // temperature is a 400 on every request (platform.claude.com thinking docs, 2026-11-04).
    /^claude-haiku-5(?:$|[-.:_])/.test(normalized) ||
    /^claude-(?:sonnet|haiku|opus|fable)-latest(?:$|[-.:_])/.test(normalized)
  );
}

function isXaiReasoningModel(model: string | undefined): boolean {
  return /^(grok-4(?:\.(?:3|5|6|7))?|grok-(?:build-)?latest)(?:$|[-.:_])/i.test(lowerModel(model));
}

/** Grok 4.5+ (and the grok-latest alias): reasoning is mandatory, no "none". */
function isModernXaiModel(model: string | undefined): boolean {
  return /^(grok-4\.[5-7]|grok-latest)(?:$|[-.:_])/.test(lowerModel(model));
}

/** Grok 4.6+ (and grok-latest, which OpenRouter maps to grok-4.7 today) also accept xhigh. */
function xaiSupportsXhigh(model: string | undefined): boolean {
  return /^(grok-4\.[67]|grok-latest)(?:$|[-.:_])/.test(lowerModel(model));
}

function isGeminiModel(model: string | undefined): boolean {
  return /^gemini(?:$|[-.:_])/.test(lowerModel(model));
}

function geminiAllowsThinkingOff(model: string | undefined): boolean {
  // 3.8 Flash (current default / flash-latest) has mandatory thinking.  Only the
  // 2.5 Flash class still accepts a full off switch.
  return /^(gemini-2\.5-(?:flash|flash-lite))(?:$|[-.:_])/.test(lowerModel(model));
}

function geminiSupportsMinimalThinking(model: string | undefined): boolean {
  const lower = lowerModel(model);
  // 3.7/3.8 Flash + the catalog alias that now resolves to it: high/medium/low only.
  if (/gemini-3\.(?:7|8)-flash/.test(lower) || /gemini-flash-latest/.test(lower)) return false;
  return isGeminiModel(model);
}

function isMistralReasoningEffortModel(model: string | undefined): boolean {
  return /^(mistral-medium-3-5|mistral-medium-latest)(?:$|[-.:_])/.test(lowerModel(model));
}

/**
 * Mistral Large 4 (catalog row mistral-large-latest, wire id mistral-large-4-0).  It reasons by
 * default.  OpenRouter lists its efforts as high|none; Mistral's own guide lists low|medium|high and
 * says it does NOT accept none.  "high" is the only value both document, so it is the only option.
 * Deliberately does not match the older mistral-large-2512 / mistral-large-2407 ids.
 */
function isMistralLarge4Model(model: string | undefined): boolean {
  return /^(mistral-large-latest|mistral-large-4(?:-0)?)(?:$|[.:_]|-(?!\d))/.test(lowerModel(model));
}

/** DeepSeek V4 / V4.1 Flash and Pro, the family-latest aliases, and the bare native ids
 *  (deepseek-flash, deepseek-pro). */
function isDeepSeekV4Model(model: string | undefined): boolean {
  return /^(deepseek-v4(?:\.\d+)?-(?:flash|pro)|deepseek-(?:flash|pro)(?:-latest)?)(?:$|[-.:_])/.test(lowerModel(model));
}

function isGpt56Model(model: string | undefined): boolean {
  return /^(gpt-5\.6|gpt-5\.6-luna|gpt-5\.6-terra|gpt-5\.6-sol)(?:$|[-.:_])/i.test(lowerModel(model));
}

/** gpt-6.1-terra and gpt-6-luna: the full none-to-max ladder (OpenRouter supported_efforts,
 *  2026-11-04; same ladder GPT-5.6 has). */
function isGpt6NoneToMaxModel(model: string | undefined): boolean {
  return /^(gpt-6\.1-terra|gpt-6-luna)(?:$|[-.:_])/i.test(lowerModel(model));
}

/** gpt-6.1-sol: reasoning is mandatory.  OpenAI's reasoning guide says it "does not support none
 *  or minimal"; OpenRouter lists low..max. */
function isGpt61SolModel(model: string | undefined): boolean {
  return /^gpt-6\.1-sol(?:$|[-.:_])/i.test(lowerModel(model));
}

/** MiniMax-M3.1-Flash: effort low..max, thinking cannot be disabled, and the provider DEFAULT is
 *  max (platform.minimax.io text-generation guide), so the app always sends an explicit effort.
 *  MiniMax-M3 is deliberately NOT matched: neither MiniMax's guide nor OpenRouter's model list
 *  documents an effort parameter for it. */
function isMinimaxEffortModel(model: string | undefined): boolean {
  return /^minimax-m3\.1-flash(?:$|[-.:_])/.test(lowerModel(model));
}

/** Muse Spark / Wonder (dev.meta.ai/docs/reasoning): minimal..max, "none" is a 400. */
function isMuseEffortModel(model: string | undefined): boolean {
  // `(?:$|…)`: the OpenRouter wire id for Wonder is the bare "meta/muse-wonder".
  return /^muse-(?:spark|wonder)(?:$|[-.:_])/.test(lowerModel(model));
}

/** Contributor models do NOT accept max (Meta: "not available with muse-spark-1.3-contributor"). */
function isMuseContributorModel(model: string | undefined): boolean {
  return /^muse-.*-contributor(?:$|:)/.test(lowerModel(model));
}

/** Muse Glimmer: OpenRouter lists low..xhigh; Meta's guide does not cover it. */
function isMuseGlimmerModel(model: string | undefined): boolean {
  return /^muse-glimmer-/.test(lowerModel(model));
}


export function reasoningCapabilityForModel(model: string | undefined): LlmReasoningCapability | undefined {
  if (isGpt56Model(model)) {
    return {
      provider: "openai",
      label: "OpenAI Reasoning",
      settingLabel: "Reasoning Effort",
      description: "GPT-5.6 supports the complete none-to-max reasoning ladder.",
      options: options(["none", "low", "medium", "high", "xhigh", "max"])
    };
  }
  if (isGpt6NoneToMaxModel(model)) {
    return {
      provider: "openai",
      label: "OpenAI Reasoning",
      settingLabel: "Reasoning Effort",
      description: "GPT-6.1 Terra and GPT-6 Luna support the complete none-to-max reasoning ladder.",
      options: options(["none", "low", "medium", "high", "xhigh", "max"])
    };
  }
  if (isGpt61SolModel(model)) {
    return {
      provider: "openai",
      label: "OpenAI Reasoning",
      settingLabel: "Reasoning Effort",
      description: "GPT-6.1 Sol always reasons (no none or minimal); low through max are supported.",
      options: options(["low", "medium", "high", "xhigh", "max"])
    };
  }
  if (isReasoningModel(model)) {
    return {
      provider: "openai",
      label: "OpenAI Reasoning",
      settingLabel: "Reasoning Effort",
      description: "OpenAI gpt-5/6 and o-series models use reasoning effort and reject custom temperature.",
      options: options(["low", "medium", "high"])
    };
  }
  if (isAnthropicAdaptiveThinkingModel(model)) {
    return {
      provider: "anthropic",
      label: "Claude Adaptive Thinking",
      settingLabel: "Thinking Effort",
      description: "Recent Claude models use adaptive thinking with provider-specific effort levels.",
      options: options(["low", "medium", "high", "xhigh", "max"])
    };
  }
  if (isXaiReasoningModel(model)) {
    const modern = isModernXaiModel(model);
    const supportsXhigh = xaiSupportsXhigh(model);
    return {
      provider: "xai",
      label: "Grok Reasoning",
      settingLabel: "Reasoning Effort",
      description: modern ? "Grok 4.5+ reasoning cannot be disabled; Grok 4.6 and 4.7 add xhigh effort." : "Grok reasoning models accept none/low/medium/high effort.",
      options: options(supportsXhigh ? ["low", "medium", "high", "xhigh"] : modern ? ["low", "medium", "high"] : ["none", "low", "medium", "high"])
    };
  }
  if (isGeminiModel(model)) {
    return {
      provider: "gemini",
      label: "Gemini Thinking",
      settingLabel: "Thinking Level",
      description: geminiAllowsThinkingOff(model)
        ? "Gemini thinking can be disabled or scaled on selected 2.5 Flash models."
        : geminiSupportsMinimalThinking(model)
          ? "Gemini thinking can be scaled, but this model family does not support turning it fully off."
          : "Gemini 3.8 Flash thinking is mandatory (low/medium/high).",
      options: options(
        geminiAllowsThinkingOff(model)
          ? ["none", "minimal", "low", "medium", "high"]
          : geminiSupportsMinimalThinking(model)
            ? ["minimal", "low", "medium", "high"]
            : ["low", "medium", "high"]
      )
    };
  }
  if (isMistralReasoningEffortModel(model)) {
    return {
      provider: "mistral",
      label: "Mistral Reasoning",
      settingLabel: "Reasoning Effort",
      description: "Mistral Medium 3.5 accepts only high or none reasoning effort.",
      options: options(["none", "high"])
    };
  }
  if (isMistralLarge4Model(model)) {
    return {
      provider: "mistral",
      label: "Mistral Reasoning",
      settingLabel: "Reasoning Effort",
      description: "Mistral Large 4 always reasons; high is the only effort both OpenRouter and Mistral document.",
      options: options(["high"])
    };
  }
  if (isMinimaxEffortModel(model)) {
    return {
      provider: "minimax",
      label: "MiniMax Thinking",
      settingLabel: "Thinking Effort",
      description: "MiniMax M3.1 Flash always thinks (it cannot be turned off) and defaults to max when no effort is sent, so the app always sends one.",
      options: options(["low", "medium", "high", "xhigh", "max"])
    };
  }
  if (isMuseEffortModel(model)) {
    const contributor = isMuseContributorModel(model);
    return {
      provider: "meta",
      // Distinct labels: the Strategy reasoning control de-duplicates capabilities by label, so a
      // contributor seat must never borrow the non-contributor ladder (which includes max).
      label: contributor ? "Muse Contributor Reasoning" : "Muse Reasoning",
      settingLabel: "Reasoning Effort",
      description: contributor
        ? "Muse contributor models always reason and do not accept max; minimal through xhigh are supported."
        : "Muse Spark and Wonder always reason (none is rejected); minimal through max are supported.",
      options: options(contributor ? ["minimal", "low", "medium", "high", "xhigh"] : ["minimal", "low", "medium", "high", "xhigh", "max"])
    };
  }
  if (isMuseGlimmerModel(model)) {
    return {
      provider: "meta",
      label: "Muse Glimmer Reasoning",
      settingLabel: "Reasoning Effort",
      description: "Muse Glimmer always reasons; low through xhigh are supported.",
      options: options(["low", "medium", "high", "xhigh"])
    };
  }
  if (isDeepSeekV4Model(model)) {
    return {
      provider: "deepseek",
      label: "DeepSeek Thinking",
      settingLabel: "Thinking Mode",
      description: "DeepSeek V4 can disable thinking or use high/max thinking effort.",
      options: options(["none", "high", "max"])
    };
  }
  return undefined;
}

/**
 * UI-ONLY synthetic reasoning capability for the "__rotate__" seat sentinel. Since the per-team
 * split (2026-07-10) a rotating seat HIDES its manual effort control — rotation auto-sets each
 * served model's curated recommended effort (src/lib/model-reasoning-recommendations.ts) — so this
 * capability now only feeds the Models card's summary line (its "Rotating Models" label) and the
 * reasoning-control helpers' rotation awareness, not an editable control.
 *
 * Deliberately NOT returned by `reasoningCapabilityForModel`: every server call path derives its
 * wire shape from that function (and from `normalizeReasoningEffortForModel`), and both must keep
 * failing closed on a raw sentinel — the strategy run substitutes the concrete rotation pick before
 * any request is shaped (src/lib/model-rotation.ts), and each served model then re-clamps the
 * effort to its own supported range (`interactiveStrategyReasoningEffort`).
 */
export const ROTATION_UI_REASONING_CAPABILITY: LlmReasoningCapability = {
  provider: "rotation",
  label: "Rotating Models",
  settingLabel: "Reasoning / Thinking Effort",
  description:
    "This seat rotates through the curated models each run. Reasoning is auto-set per rotated model " +
    "at its curated recommended level (models without a curated recommendation run Medium).",
  options: options(ALL_LLM_REASONING_EFFORTS)
};

export function normalizeReasoningEffortForOptions(
  optionsForModel: readonly Pick<LlmReasoningOption, "value">[],
  effort: LlmReasoningEffort | undefined
): LlmReasoningEffort {
  const allowed = optionsForModel.map((option) => option.value);
  if (allowed.length === 0) return "medium";
  if (effort === undefined) return allowed.includes("medium") ? "medium" : (allowed[0] ?? "medium");
  const requested = effort;
  if (allowed.includes(requested)) return requested;
  const requestedRank = ALL_LLM_REASONING_EFFORTS.indexOf(requested);
  const rankedAllowed = allowed
    .map((value) => ({ value, distance: Math.abs(ALL_LLM_REASONING_EFFORTS.indexOf(value) - requestedRank) }))
    .sort((a, b) => a.distance - b.distance || ALL_LLM_REASONING_EFFORTS.indexOf(a.value) - ALL_LLM_REASONING_EFFORTS.indexOf(b.value));
  return rankedAllowed[0]?.value ?? allowed[0] ?? "medium";
}

export function normalizeReasoningEffortForModel(
  model: string | undefined,
  effort: LlmReasoningEffort | undefined
): LlmReasoningEffort | undefined {
  const capability = reasoningCapabilityForModel(model);
  if (!capability) return undefined;
  if (capability.provider === "deepseek") {
    // DeepSeek V4 exposes only three tiers: thinking OFF ("none"), "high", and "max". A sub-high
    // request (none/minimal/low/medium — including the app's "medium" DEFAULT) resolves to the FAST
    // "none" tier, NOT a silent upgrade to "high". "high" spends a long, unbounded hidden-reasoning
    // phase server-side before emitting any visible JSON; on a non-streaming whole-response await that
    // routinely blew the 60s request timeout (Green/Bear "timed out after 60s using DeepSeek"). High-
    // effort DeepSeek thinking is now OPT-IN: choose "high"/"xhigh"/"max" explicitly. The settings UI
    // resolves the displayed effort through this SAME function, so the effort shown is always exactly
    // the effort sent — the user can never select a value different from what actually runs.
    if (effort === "max" || effort === "xhigh") return "max";
    if (effort === "high") return "high";
    return "none";
  }
  if (capability.provider === "mistral" && capability.options.some((option) => option.value === "none")) {
    // Mistral Medium 3.5 accepts exactly two efforts (provider 400: "supported values:
    // [high, none]"). Same opt-in rule as DeepSeek above: only an explicit high/xhigh/max
    // enables the slow high-reasoning tier; everything else — including the app's "medium"
    // default — resolves to "none" rather than silently upgrading to high. (The generic
    // rank-distance normalization below would map "medium" to "high".) The settings UI
    // resolves through this same function, so the effort shown equals the effort sent.
    if (effort === "high" || effort === "xhigh" || effort === "max") return "high";
    return "none";
  }
  return normalizeReasoningEffortForOptions(capability.options, effort);
}

/**
 * Resolve the Red Team reviewer's reasoning effort from a policy: the reviewer-specific
 * `redTeamReasoningEffort` when explicitly set, otherwise the proposer's legacy
 * `llmReasoningEffort` (per-team split 2026-07-10: the legacy field is the PROPOSER's; the
 * reviewer inherits it until the owner explicitly sets its own). Every reviewer/red-team call
 * site MUST resolve through this helper so the fallback lives in exactly one place — never read
 * `policy.redTeamReasoningEffort` directly at a call site.
 */
export function resolveReviewerReasoningEffort(
  policy?: { llmReasoningEffort?: LlmReasoningEffort; redTeamReasoningEffort?: LlmReasoningEffort } | null
): LlmReasoningEffort | undefined {
  return policy?.redTeamReasoningEffort ?? policy?.llmReasoningEffort;
}

export function isDisallowedInteractiveStrategyReasoningConfig(model: string | undefined, effort: LlmReasoningEffort | undefined): boolean {
  const normalized = normalizeReasoningEffortForModel(model, effort);
  return /^gpt-5\.5(?:$|[-.:_])/i.test(lowerModel(model)) && normalized === "high";
}

export function interactiveStrategyReasoningEffort(model: string, effort: LlmReasoningEffort | undefined): LlmReasoningEffort | undefined {
  const normalized = normalizeReasoningEffortForModel(model, effort);
  if (!normalized) return undefined;
  return isDisallowedInteractiveStrategyReasoningConfig(model, normalized) ? "medium" : normalized;
}

