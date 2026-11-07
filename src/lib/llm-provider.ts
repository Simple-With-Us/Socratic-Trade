import { codeCliReady, codeCliUrl } from "./code-cli";
import { resolveLlmCredential } from "./db";
import { catalogEntryFor, isCodeCliOnlyModel, nativeSlugFor, openRouterSlugFor } from "./llm-model-catalog";
import { resolveOpenAiModel, type LlmTransport } from "./llm-request";
import { llmRouteFor } from "./llm-route";

export type LlmTeamRole = "green" | "red" | "support";
export type LlmModelFamily = "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "meta" | "moonshot" | "minimax" | "openrouter";

export interface LlmEndpoint {
  provider: "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "meta" | "moonshot" | "minimax" | "openrouter";
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
  let normalized = (model ?? "").trim().toLowerCase();
  normalized = normalized.replace(/^openrouter\//i, "");

  if (/claude/i.test(normalized)) return "anthropic";
  if (/grok/i.test(normalized)) return "xai";
  if (/gemini/i.test(normalized)) return "gemini";
  if (/(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)/i.test(normalized)) return "mistral";
  if (/deepseek/i.test(normalized)) return "deepseek";
  // Llama models are gone from the catalog (ST-4589).  A stale stored llama id still classifies as
  // Meta so it can never fall through to the OpenAI default and reach api.openai.com.
  if (/(llama|muse-)/i.test(normalized)) return "meta";
  if (/(kimi|moonshot)/i.test(normalized)) return "moonshot";
  if (/minimax/i.test(normalized)) return "minimax";
  return "openai";
}

/** Explicit OpenRouter ids, Meta, and restricted catalog entries require OpenRouter transport. */
export function modelRequiresOpenRouter(model: string | undefined): boolean {
  return /^openrouter\//i.test((model ?? "").trim())
    || llmModelFamily(model) === "meta"
    || catalogEntryFor(model)?.openRouterOnly === true;
}

/** Meta Model API chat-completions URL (OpenAI-compatible, bearer key). */
export const META_MODEL_API_URL = "https://api.meta.ai/v1/chat/completions";

/**
 * The Meta-hosted slug the native Model API (api.meta.ai) serves for this model, or undefined.
 * Muse Spark and Muse Wonder are hosted there (dev.meta.ai/docs/reasoning names muse-spark-1.3 and
 * muse-wonder-1.0).  Glimmer is open-weight and stays OpenRouter-only.  Code CLI-only contributor
 * ids (muse-wonder-*-contributor) are never sent to api.meta.ai.
 */
export function metaNativeModelSlug(model: string | undefined): string | undefined {
  const entry = catalogEntryFor(model);
  if (!entry || entry.codeCliOnly) return undefined;
  return /^muse-(?:spark|wonder)-/i.test(entry.nativeSlug) ? entry.nativeSlug : undefined;
}

/** The Muse Code id the Code CLI broker serves for this model: Spark, Wonder, and the Code
 *  CLI-only Wonder contributor ids.  Undefined for anything else (Glimmer, unknown ids). */
export function metaCodeCliModelSlug(model: string | undefined): string | undefined {
  const slug = catalogEntryFor(model)?.nativeSlug ?? "";
  return /^muse-(?:spark|wonder)-/i.test(slug) ? slug : undefined;
}

/**
 * A model that cannot be served for this user on the route they chose (today: a Code CLI-only
 * model while the user's Meta route is not Code CLI).  Failover chains treat it like a model with
 * no credential: skip it and try the next one.
 */
export class LlmModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmModelUnavailableError";
  }
}

/** Shown when a stored policy still names a removed Llama model. */
export const LLAMA_REMOVED_MESSAGE = "Llama models are no longer offered; pick another model";

/** The error codeCliUrl throws when the Code CLI route is selected but not enabled/configured. */
export const CODE_CLI_NOT_CONFIGURED_MESSAGE = "Code CLI is disabled or not configured for this owner";

/** True for endpoint-resolution errors a failover chain should SKIP (the model is unavailable for
 *  this user) rather than abort on.  Any other error (DB/runtime) must still propagate. */
export function isUnavailableModelResolutionError(error: unknown): boolean {
  if (error instanceof LlmModelUnavailableError) return true;
  return error instanceof Error && error.message === CODE_CLI_NOT_CONFIGURED_MESSAGE;
}

/** False only for a Code CLI-only model when this user's Meta route is not a ready Code CLI route.
 *  Rotation and implicit failover use it so those models are picked only where they can run. */
export function codeCliOnlyModelServable(model: string | undefined, userId: string = "local"): boolean {
  if (!isCodeCliOnlyModel(model)) return true;
  return llmRouteFor("meta", userId) === "code-cli" && codeCliReady(userId);
}

/**
 * False when this user's chosen route cannot serve the model at all: a Code CLI-only model off a
 * ready Code CLI route, or a Meta model the Code CLI broker has no adapter for (Glimmer) while the
 * user's Meta route IS Code CLI.  Rotation uses it so a pick or implicit failover never lands on a
 * model resolveLlmEndpoint would refuse.  (Code CLI selected but not ready is already caught by the
 * credential check: resolveLlmCredential returns no key.)
 */
export function modelServableOnUserRoute(model: string | undefined, userId: string = "local"): boolean {
  if (!codeCliOnlyModelServable(model, userId)) return false;
  const family = llmModelFamily(model);
  if (family === "meta" && llmRouteFor("meta", userId) === "code-cli") return Boolean(metaCodeCliModelSlug(model));
  return true;
}

/**
 * Native Meta route: the user's own Meta key (or the operator failover) for a Muse Spark model,
 * used only when the user chose "direct" for Meta in Settings (default is OpenRouter).
 * Returns undefined when the model is not Meta-hosted or no Meta key resolves, so callers fall
 * through to OpenRouter.  A resolved key equal to the OpenRouter key is never treated as a Meta
 * key, so an OpenRouter credential can not leak to api.meta.ai through the test-mode fallback.
 */
export function resolveMetaNative(
  model: string | undefined,
  userId: string = "local"
): { key: string; model: string; keySource: "operator" | "user"; keyRef?: string } | undefined {
  const slug = metaNativeModelSlug(model);
  if (!slug) return undefined;
  // OpenRouter is the default route.  Native Meta only when the user picked it in Settings.
  if (llmRouteFor("meta", userId) !== "native") return undefined;
  const cred = resolveLlmCredential("meta", userId);
  if (!cred.key) return undefined;
  if (cred.key === resolveLlmCredential("openrouter", userId).key) return undefined;
  return { key: cred.key, model: slug, keySource: cred.source === "operator" ? "operator" : "user", keyRef: cred.keyRef };
}

/** True when the user chose "direct" for MiniMax and a MiniMax key resolves.  OpenRouter is the default. */
export function minimaxDirectRoute(model: string | undefined, userId: string = "local"): boolean {
  return llmModelFamily(model) === "minimax"
    && !/^openrouter\//i.test((model ?? "").trim())
    && llmRouteFor("minimax", userId) === "native"
    && Boolean(resolveLlmCredential("minimax", userId).key);
}

/** Credential gate follows the same OpenRouter-first, native-fallback routing as execution. */
export function modelCredentialService(model: string | undefined, userId: string = "local"): LlmModelFamily {
  const family = llmModelFamily(model);
  if ((family === "meta" || family === "minimax") && llmRouteFor(family, userId) === "code-cli") return family;
  if (resolveMetaNative(model, userId)) return "meta";
  if (minimaxDirectRoute(model, userId)) return "minimax";
  return modelRequiresOpenRouter(model) || resolveLlmCredential("openrouter", userId).key
    ? "openrouter" : llmModelFamily(model);
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

/** Current OpenRouter Flash class — catalog column 2. Bare slug 404s. */
export const OPENROUTER_GEMINI_FLASH = "~google/gemini-flash-latest";
/** Pinned 3.8 batch/offline slug (the latest alias has no :batch sibling). */
export const OPENROUTER_GEMINI_FLASH_BATCH = "google/gemini-3.8-flash:batch";
/** Google AI Studio native Flash class — catalog column 3. */
export const NATIVE_GEMINI_FLASH = "gemini-flash-latest";

/**
 * Maps a catalog / persisted model ID to the native provider slug (column 3).
 * Uses `nativeSlugFor` so a future direct path never sends an OpenRouter wire id.
 */
export function nativeModelSlugForProvider(model: string, _family: LlmModelFamily): string {
  return nativeSlugFor(model);
}

export { nativeSlugFor } from "./llm-model-catalog";

export function stripOpenRouterTilde(id: string): string {
  return id.trim().replace(/^~/, "").replace(/\/~/g, "/");
}

function prefixUnknownOpenRouterId(raw: string): string {
  const model = raw.replace(/^openrouter\//i, "");
  const keepTilde = /^\s*~/.test(model);
  const unprefixed = stripOpenRouterTilde(model);
  let out: string;
  if (unprefixed.includes("/")) {
    out = unprefixed.replace(/^xai\//i, "x-ai/").replace(/^moonshot\//i, "moonshotai/");
  } else if (/^claude/i.test(unprefixed)) {
    out = `anthropic/${unprefixed}`;
  } else if (/^grok/i.test(unprefixed)) {
    out = `x-ai/${unprefixed}`;
  } else if (/^gemini/i.test(unprefixed)) {
    out = `google/${unprefixed}`;
  } else if (/(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)/i.test(unprefixed)) {
    out = `mistralai/${unprefixed}`;
  } else if (/(kimi|moonshot)/i.test(unprefixed)) {
    out = `moonshotai/${unprefixed}`;
  } else if (/minimax/i.test(unprefixed)) {
    out = `minimax/${unprefixed}`;
  } else if (/^deepseek/i.test(unprefixed)) {
    out = `deepseek/${unprefixed}`;
  } else if (/^(gpt|o1|o3)/i.test(unprefixed)) {
    out = `openai/${unprefixed}`;
  } else {
    out = unprefixed;
  }
  return keepTilde && !out.startsWith("~") ? `~${out}` : out;
}

/**
 * Normalize a catalog or persisted model name to the OpenRouter wire ID (column 2).
 * Catalog hits never send a display slug when it differs from the wire slug.
 */
export function normalizeOpenRouterModelId(rawModel: string | undefined): string {
  const catalog = openRouterSlugFor(rawModel);
  if (catalog) return catalog;
  return prefixUnknownOpenRouterId((rawModel ?? "").trim());
}


export function resolveLlmEndpoint(
  policy?: { llmModel?: string | null; redTeamLlmModel?: string | null } | null,
  userId: string = "local",
  defaultOpenAiUrl: string = "https://api.openai.com/v1/chat/completions",
  role: LlmTeamRole = "green"
): LlmEndpoint {
  const rawModel = resolveRoleModel(policy, role);
  // Llama models are gone (ST-4589).  A stale stored llama id would reach OpenRouter unprefixed and
  // 400; refuse it legibly instead, as an unavailable model the failover chains skip.
  if (/llama/i.test(rawModel)) throw new LlmModelUnavailableError(LLAMA_REMOVED_MESSAGE);
  const family = llmModelFamily(rawModel);
  if ((family === "meta" || family === "minimax") && llmRouteFor(family, userId) === "code-cli") {
    const cliModel = family === "meta" ? metaCodeCliModelSlug(rawModel) : nativeSlugFor(rawModel);
    // e.g. muse-glimmer-30b while Meta is on Code CLI: unavailable for this user, so failover skips it.
    if (!cliModel) throw new LlmModelUnavailableError(`${rawModel} is not supported by the Code CLI route`);
    return { provider: family, url: codeCliUrl(family, userId), key: "code-cli-no-provider-key",
      model: cliModel, keySource: "user", keyRef: "code-cli", transport: "chat-completions" };
  }
  // Code CLI-only ids exist on no other route: never send them to OpenRouter or api.meta.ai.
  if (isCodeCliOnlyModel(rawModel)) {
    throw new LlmModelUnavailableError(`${rawModel} runs only through the Code CLI route`);
  }


  // 0. Native Meta: when the user chose "direct" for Meta and has a Meta key, a Muse Spark model
  //    goes straight to api.meta.ai.  Otherwise it falls through to OpenRouter below.
  const metaNative = resolveMetaNative(rawModel, userId);
  if (metaNative) {
    return {
      provider: "meta",
      url: process.env.META_API_URL?.trim() || META_MODEL_API_URL,
      key: metaNative.key,
      model: metaNative.model,
      keySource: metaNative.keySource,
      keyRef: metaNative.keyRef,
      transport: "chat-completions"
    };
  }

  // 1. Primary path: OpenRouter key (user or operator failover when enabled)
  const openRouterCred = resolveLlmCredential("openrouter", userId);
  // Meta models are served through OpenRouter; never send a Meta credential to OpenAI.
  if (!minimaxDirectRoute(rawModel, userId) && (openRouterCred.key || modelRequiresOpenRouter(rawModel))) {
    const model = normalizeOpenRouterModelId(rawModel);
    const url = process.env.OPENROUTER_API_URL?.trim() || "https://openrouter.ai/api/v1/chat/completions";

    return {
      provider: "openrouter",
      url,
      key: openRouterCred.key,
      model,
      keySource: openRouterCred.source === "operator" ? "operator" : "user",
      keyRef: openRouterCred.keyRef,
      transport: "chat-completions"
    };
  }

  // 2. Direct provider path: check user-provided key for model's native family
  const nativeCred = resolveLlmCredential(family, userId);
  const nativeModel = nativeModelSlugForProvider(rawModel, family);

  if (family === "anthropic") {
    return {
      provider: "anthropic",
      url: "https://api.anthropic.com/v1/messages",
      key: nativeCred.key,
      model: nativeModel,
      keySource: nativeCred.source === "operator" ? "operator" : "user",
      keyRef: nativeCred.keyRef,
      transport: "anthropic-messages"
    };
  } else if (family === "xai") {
    return {
      provider: "xai",
      url: process.env.XAI_API_URL?.trim() || "https://api.x.ai/v1/chat/completions",
      key: nativeCred.key,
      model: nativeModel,
      keySource: nativeCred.source === "operator" ? "operator" : "user",
      keyRef: nativeCred.keyRef,
      transport: "chat-completions"
    };
  } else if (family === "gemini") {
    return {
      provider: "gemini",
      url: process.env.GEMINI_API_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      key: nativeCred.key,
      model: nativeModel,
      keySource: nativeCred.source === "operator" ? "operator" : "user",
      keyRef: nativeCred.keyRef,
      transport: "chat-completions"
    };
  } else if (family === "mistral") {
    return {
      provider: "mistral",
      url: process.env.MISTRAL_API_URL?.trim() || "https://api.mistral.ai/v1/chat/completions",
      key: nativeCred.key,
      model: nativeModel,
      keySource: nativeCred.source === "operator" ? "operator" : "user",
      keyRef: nativeCred.keyRef,
      transport: "chat-completions"
    };
  } else if (family === "deepseek") {
    return {
      provider: "deepseek",
      url: process.env.DEEPSEEK_API_URL?.trim() || "https://api.deepseek.com/v1/chat/completions",
      key: nativeCred.key,
      model: nativeModel,
      keySource: nativeCred.source === "operator" ? "operator" : "user",
      keyRef: nativeCred.keyRef,
      transport: "chat-completions"
    };
  } else if (family === "moonshot") {
    return {
      provider: "moonshot",
      url: process.env.MOONSHOT_API_URL?.trim() || "https://api.moonshot.cn/v1/chat/completions",
      key: nativeCred.key,
      model: nativeModel,
      keySource: nativeCred.source === "operator" ? "operator" : "user",
      keyRef: nativeCred.keyRef,
      transport: "chat-completions"
    };
  } else if (family === "minimax") {
    return {
      provider: "minimax",
      url: process.env.MINIMAX_API_URL?.trim() || "https://api.minimax.io/v1/chat/completions",
      key: nativeCred.key,
      model: nativeModel,
      keySource: nativeCred.source === "operator" ? "operator" : "user",
      keyRef: nativeCred.keyRef,
      transport: "chat-completions"
    };
  }

  // OpenAI / fallback
  return {
    provider: "openai",
    url: process.env.OPENAI_API_URL?.trim() || defaultOpenAiUrl,
    key: nativeCred.key,
    model: nativeModel,
    keySource: nativeCred.source === "operator" ? "operator" : "user",
    keyRef: nativeCred.keyRef,
    transport: "chat-completions"
  };
}
