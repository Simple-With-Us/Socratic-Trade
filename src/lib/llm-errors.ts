// Plain-English LLM error mapping. PURE — no node/server imports — so it is safe to import from both
// client components (the Assistant console) and server libs (strategy/red-team/etc). It turns a raw
// provider error (status code + response body) into a short, user-actionable sentence, and falls back
// to the trimmed raw text when it does not recognize the shape, so nothing is ever hidden.

export type LlmProviderName = "OpenAI" | "Anthropic (Claude)" | "xAI (Grok)" | "Google (Gemini)" | "Mistral" | "DeepSeek" | "the LLM";

/** Map an internal provider id (openai/xai/gemini/mistral/deepseek/anthropic) to a display name. */
export function providerLabel(provider?: string | null): LlmProviderName {
  switch ((provider ?? "").toLowerCase()) {
    case "xai":
      return "xAI (Grok)";
    case "gemini":
      return "Google (Gemini)";
    case "mistral":
      return "Mistral";
    case "deepseek":
      return "DeepSeek";
    case "anthropic":
      return "Anthropic (Claude)";
    case "openai":
      return "OpenAI";
    default:
      return "the LLM";
  }
}

/** Best-effort provider detection from an error string (host names, key prefixes, model families). */
export function providerFromText(raw: string): LlmProviderName {
  const s = raw.toLowerCase();
  if (/x\.ai|\bxai\b|grok/.test(s)) return "xAI (Grok)";
  if (/anthropic|claude/.test(s)) return "Anthropic (Claude)";
  if (/generativelanguage|gemini/.test(s)) return "Google (Gemini)";
  if (/mistral|mixtral|codestral|ministral/.test(s)) return "Mistral";
  if (/deepseek/.test(s)) return "DeepSeek";
  if (/openai|platform\.openai|^sk-/.test(s)) return "OpenAI";
  return "the LLM";
}

/**
 * Convert a raw LLM error (and optional HTTP status) into a plain-English, actionable message.
 * Pass `status` explicitly when you have it (avoids mis-reading numbers in the body); pass `provider`
 * (internal id, e.g. "gemini") when the caller already knows it (more reliable than text sniffing).
 */
export function humanizeLlmError(raw: string | undefined | null, opts: { provider?: string; status?: number } = {}): string {
  const text = (raw ?? "").toString().trim();
  const provider = opts.provider ? providerLabel(opts.provider) : text ? providerFromText(text) : "the LLM";
  if (!text && opts.status === undefined) return `${provider} request failed for an unknown reason. Try again.`;
  const s = text.toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => s.includes(n));
  // Trust an explicit status; otherwise read a leading 3-digit HTTP code from the text.
  const status = opts.status ?? (() => {
    const m = s.match(/\b(?:failed with |status[: ]+|http |code[: ]+)?([45]\d\d)\b/);
    return m ? Number(m[1]) : undefined;
  })();

  if (status === 401 || has("incorrect api key", "invalid_api_key", "invalid api key", "api key not valid", "unauthorized", "no auth credential", "authentication_error", "x-api-key"))
    return `${provider} rejected the API key. Add or update the ${provider} key in Settings → Connections.`;

  if (status === 403 || has("permission", "do not have access", "does not have access", "not allowed", "forbidden", "unsupported_country", "region"))
    return `Your ${provider} key doesn't have access to this model or region. Pick a different model, or check your ${provider} plan.`;

  if (status === 404 || has("model not found", "does not exist", "no such model", "model_not_found", "unknown model"))
    return `That model isn't available on your ${provider} account. Choose a different model in the picker.`;

  if (status === 429 || has("rate limit", "rate_limit", "too many requests", "quota", "insufficient_quota", "billing", "credit balance", "out of credit", "payment required"))
    return `Your ${provider} account hit a rate limit or is out of quota/credits. Wait and retry, or check ${provider} billing.`;

  if ((status !== undefined && status >= 500) || has("overloaded", "service unavailable", "internal server error", "bad gateway", "gateway timeout"))
    return `${provider} is temporarily unavailable (server error). Try again in a moment.`;

  if (has("timed out", "timeout", "aborted", "network error", "fetch failed", "econnreset", "enotfound", "socket hang up"))
    return `Couldn't reach ${provider} (network or timeout). Check connectivity and try again.`;

  if (has("context length", "maximum context", "too many tokens", "token limit", "string too long"))
    return `The request was too long for ${provider}'s context window. Shorten the input or pick a larger-context model.`;

  // Unrecognized — surface the raw provider text (single-line, trimmed) rather than hide it.
  return text ? `${provider} error: ${text.replace(/\s+/g, " ").slice(0, 240)}` : `${provider} request failed (HTTP ${status}).`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return error === undefined || error === null ? "" : String(error);
}

function isTimeoutLike(raw: string): boolean {
  return /\b(timeout|timed out|aborted|aborterror)\b/i.test(raw);
}

export function humanizeLlmTransportError(
  error: unknown,
  opts: { provider?: string; model?: string; stepLabel?: string; timeoutMs?: number } = {}
): string {
  const provider = providerLabel(opts.provider);
  const model = opts.model?.trim();
  const modelPart = model ? ` ${model}` : "";
  const step = opts.stepLabel?.trim() || "LLM request";
  const raw = errorText(error);

  if (isTimeoutLike(raw)) {
    const timeoutPart = opts.timeoutMs && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? ` after ${Math.round(opts.timeoutMs / 1000)}s` : "";
    return `${step} timed out${timeoutPart} using ${provider}${modelPart}. Lower reasoning effort, choose a faster model, or retry.`;
  }

  return `${step} failed using ${provider}${modelPart}: ${humanizeLlmError(raw, { provider: opts.provider })}`;
}
