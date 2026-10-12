// Plain-English LLM error mapping. PURE — no node/server imports — so it is safe to import from both
// client components (the Assistant console) and server libs (strategy/red-team/etc). It turns a raw
// provider error (status code + response body) into a short, user-actionable sentence, and falls back
// to the trimmed raw text when it does not recognize the shape, so nothing is ever hidden.

export type LlmProviderName = "OpenAI" | "Anthropic (Claude)" | "xAI (Grok)" | "Google (Gemini)" | "Mistral" | "DeepSeek" | "Moonshot AI (Kimi)" | "MiniMax" | "OpenRouter" | "the LLM";

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
    case "moonshot":
    case "kimi":
      return "Moonshot AI (Kimi)";
    case "minimax":
      return "MiniMax";
    case "openrouter":
      return "OpenRouter";
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
  if (/moonshot|kimi/.test(s)) return "Moonshot AI (Kimi)";
  if (/minimax/.test(s)) return "MiniMax";
  if (/openrouter/.test(s)) return "OpenRouter";
  if (/deepseek/.test(s)) return "DeepSeek";
  if (/openai|platform\.openai|^sk-/.test(s)) return "OpenAI";
  return "the LLM";
}

/**
 * Structured provider-error envelope pulled out of a raw response body. Covers both Google-RPC
 * shapes (`{error:{code,message,status,details?}}` and the array-wrapped `[{error:{...}}]` the
 * Gemini endpoint emits) and the OpenAI-style `{error:{message,type,code}}`.
 */
function extractStructuredProviderError(
  raw: string
): { message: string; status?: string; code?: number | string; details?: unknown } | undefined {
  const trimmed = raw.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const candidate of candidates) {
    const err = (candidate as { error?: unknown } | null)?.error;
    if (!err || typeof err !== "object") continue;
    const e = err as { code?: unknown; status?: unknown; type?: unknown; message?: unknown; details?: unknown };
    if (typeof e.message !== "string" || e.message.length === 0) continue;
    return {
      message: e.message,
      status: typeof e.status === "string" ? e.status : typeof e.type === "string" ? e.type : undefined,
      code: typeof e.code === "number" || typeof e.code === "string" ? e.code : undefined,
      details: e.details
    };
  }
  return undefined;
}

const DETAIL_MESSAGE_MAX = 300;
const DETAIL_RAW_MAX = 300;

/** Strip credentials from provider text before it is persisted. PURE.  Covers bearer tokens, sk-*
 *  style keys (incl. sk-or-v1-), api_key/key/token query or JSON values, authorization/cookie
 *  headers, and any long opaque token-looking run. */
export function redactProviderText(text: string): string {
  return text
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)\b\s*[:=]\s*[^\n,;}"']+/gi, "$1: [redacted]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|key)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi, "$1$2[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
}

function oneLine(text: string, max: number): string {
  const flat = redactProviderText(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/**
 * Sanitized, bounded provider diagnostic that rides alongside the friendly sentence, so the real
 * cause (status, provider code/type, upstream provider, wire model, provider message) survives
 * persistence and re-wrapping instead of being flattened into "key doesn't have access".
 * Returns "" when there is nothing to add.
 */
export function describeProviderErrorDetail(
  raw: string | undefined | null,
  opts: { status?: number; model?: string } = {}
): string {
  const text = (raw ?? "").toString().trim();
  const parts: string[] = [];
  if (opts.status !== undefined) parts.push(`HTTP ${opts.status}`);
  if (opts.model) parts.push(`model ${oneLine(opts.model, 120)}`);
  const structured = extractStructuredProviderError(text);
  if (structured) {
    if (structured.code !== undefined) parts.push(`code ${oneLine(String(structured.code), 60)}`);
    if (structured.status) parts.push(`type ${oneLine(structured.status, 60)}`);
    // OpenRouter nests the upstream provider and its raw body under error.metadata.
    try {
      const parsed = JSON.parse(text) as unknown;
      const first = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: { metadata?: { provider_name?: unknown; raw?: unknown; reasons?: unknown } } } | undefined;
      const meta = first?.error?.metadata;
      if (meta && typeof meta.provider_name === "string") parts.push(`upstream ${oneLine(meta.provider_name, 60)}`);
      if (meta && Array.isArray(meta.reasons) && meta.reasons.length > 0) parts.push(`reasons ${oneLine(meta.reasons.map(String).join(","), 120)}`);
      if (meta && meta.raw !== undefined && meta.raw !== null) {
        const rawMeta = typeof meta.raw === "string" ? meta.raw : JSON.stringify(meta.raw);
        parts.push(`upstream raw "${oneLine(rawMeta, 200)}"`);
      }
    } catch {
      // extractStructuredProviderError already proved the body parses; ignore anyway.
    }
    parts.push(`message "${oneLine(structured.message, DETAIL_MESSAGE_MAX)}"`);
  } else if (text) {
    parts.push(`body "${oneLine(text, DETAIL_RAW_MAX)}"`);
  }
  return parts.length > 0 ? `[provider detail: ${parts.join("; ")}]` : "";
}

/** Matches text that is ALREADY a humanizeLlmError output ("<Provider label> error ...: ...") so a
 *  second pass (e.g. humanizeLlmTransportError re-wrapping an Error whose message was humanized at
 *  the throw site) returns it unchanged instead of stuttering "Gemini error: Gemini error: ...". */
const ALREADY_HUMANIZED =
  /^(?:OpenAI|Anthropic \(Claude\)|xAI \(Grok\)|Google \(Gemini\)|Mistral|DeepSeek|Moonshot AI \(Kimi\)|MiniMax|OpenRouter|the LLM) error\b|^(?:That model id isn't valid on |That model isn't available on your |Couldn't complete this model request\.|.+ had no compatible endpoint for this request\.)/;

/**
 * Convert a raw LLM error (and optional HTTP status) into a plain-English, actionable message.
 * Pass `status` explicitly when you have it (avoids mis-reading numbers in the body); pass `provider`
 * (internal id, e.g. "gemini") when the caller already knows it (more reliable than text sniffing).
 */
export function humanizeLlmError(raw: string | undefined | null, opts: { provider?: string; status?: number; model?: string } = {}): string {
  const text = (raw ?? "").toString().trim();
  const provider = opts.provider ? providerLabel(opts.provider) : text ? providerFromText(text) : "the LLM";
  if (!text && opts.status === undefined) return `${provider} request failed for an unknown reason. Try again.`;
  if (ALREADY_HUMANIZED.test(text) || text.includes("[provider detail:")) return text;
  // Appended to the status-driven sentences below; two spaces between sentences.
  const detailText = describeProviderErrorDetail(text, { status: opts.status, model: opts.model });
  const withDetail = (message: string): string => (detailText ? `${message}  ${detailText}` : message);
  const s = text.toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => s.includes(n));
  // Trust an explicit status; otherwise read a leading 3-digit HTTP code from the text.
  const status = opts.status ?? (() => {
    const m = s.match(/\b(?:failed with |status[: ]+|http |code[: ]+)?([45]\d\d)\b/);
    return m ? Number(m[1]) : undefined;
  })();

  if (status === 401 || has("incorrect api key", "invalid_api_key", "invalid api key", "api key not valid", "unauthorized", "no auth credential", "authentication_error", "x-api-key"))
    return withDetail(`${provider} rejected the API key. Add or update the ${provider} key in Connections.`);

  if (status === 403 || has("permission", "do not have access", "does not have access", "not allowed", "forbidden", "unsupported_country", "region"))
    return withDetail(`Your ${provider} key doesn't have access to this model or region.  Pick a different model, or check your ${provider} plan.`);

  // OpenRouter require_parameters 404 — the model exists; no endpoint advertised
  // every request field.  Never call that an account allowlist miss.
  const noEndpointRouting = has(
    "no endpoints found",
    "no endpoints available",
    "no endpoint found",
    "no available providers",
    "no provider available"
  );
  if (status === 404 && noEndpointRouting)
    return withDetail(`${provider} had no compatible endpoint for this request.  Try again, or choose a different model.`);

  // A true model_not_found is a bad slug, not an account-privacy miss.
  // A bare 404 is "couldn't complete", never "isn't available on your account".
  const modelMissingBody = has(
    "model not found",
    "does not exist",
    "no such model",
    "model_not_found",
    "unknown model",
    "do not have access",
    "does not have access",
    "no access to this model",
    "no access to the model"
  );
  if ((status === 404 || status === 403) && modelMissingBody)
    return withDetail(`That model id isn't valid on ${provider}.  Choose a different model in the picker.`);
  if (status === 404)
    return withDetail(`Couldn't complete this model request.  Try again, or choose a different model.`);

  if (status === 402 || status === 429 || has("rate limit", "rate_limit", "too many requests", "quota", "insufficient_quota", "billing", "credit balance", "out of credit", "payment required"))
    return withDetail(`Your ${provider} account hit a rate limit or is out of quota/credits. Wait and retry, or check ${provider} billing.`);

  // Anthropic's org/workspace-level "specified API usage limit" (distinct from a 429 rate limit —
  // this is an admin-configured spend cap) comes back as a 400 invalid_request_error, so it doesn't
  // match the 429/quota branch above and previously fell through to a raw-JSON dump.
  if (has("usage limit", "usage limits")) {
    const regainMatch = text.match(/regain access ((?:on )?[^."]+)/i);
    const when = regainMatch ? ` You'll regain access ${regainMatch[1].trim()}.` : "";
    return `${provider} has hit its configured API usage limit for this account.${when} Raise the limit with your ${provider} plan/console, or wait for it to reset.`;
  }

  if ((status !== undefined && status >= 500) || has("overloaded", "service unavailable", "internal server error", "bad gateway", "gateway timeout"))
    return withDetail(`${provider} is temporarily unavailable (server error). Try again in a moment.`);

  if (has("timed out", "timeout", "aborted", "network error", "fetch failed", "econnreset", "enotfound", "socket hang up"))
    return `Couldn't reach ${provider} (network or timeout). Check connectivity and try again.`;

  if (has("context length", "maximum context", "too many tokens", "token limit", "string too long"))
    return `The request was too long for ${provider}'s context window. Shorten the input or pick a larger-context model.`;

  // Unrecognized but STRUCTURED (a provider JSON error envelope): surface the provider's own
  // message, status/code, and — critically — the `details` array when present, WITHOUT the 240-char
  // truncation below. Gemini's INVALID_ARGUMENT 400s are the motivating case: the generic message
  // ("Request contains an invalid argument.") is useless on its own, so when Google attaches a
  // details array (field violations etc.) it must survive into the persisted run summary/audit
  // instead of being sliced off.
  const structured = extractStructuredProviderError(text);
  if (structured) {
    const label = [
      typeof structured.code === "number" || typeof structured.code === "string" ? String(structured.code) : undefined,
      structured.status
    ]
      .filter(Boolean)
      .join(" ");
    let out = `${provider} error${label ? ` ${label}` : ""}: ${structured.message.replace(/\s+/g, " ").trim()}`;
    if (structured.details !== undefined) {
      let detailsJson: string;
      try {
        detailsJson = JSON.stringify(structured.details);
      } catch {
        detailsJson = String(structured.details);
      }
      // Generous (not unbounded) cap — big enough for any realistic google.rpc details array,
      // small enough to keep audit/notification rows sane.
      out += `; details: ${detailsJson.slice(0, 2000)}`;
    }
    return out;
  }

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
  let model = opts.model?.trim();
  if (model && model.includes("/")) {
    model = model.split("/").pop();
  }
  const modelPart = model ? ` ${model}` : "";
  const step = opts.stepLabel?.trim() || "LLM request";
  const raw = errorText(error);

  if (isTimeoutLike(raw)) {
    const timeoutPart = opts.timeoutMs && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? ` after ${Math.round(opts.timeoutMs / 1000)}s` : "";
    return `${step} timed out${timeoutPart} using ${provider}${modelPart}. Lower reasoning effort, choose a faster model, or retry.`;
  }

  return `${step} failed using ${provider}${modelPart}: ${humanizeLlmError(raw, { provider: opts.provider, model: opts.model })}`;
}
