export * from "./llm-reasoning";
import { lowerModel, normalizeReasoningEffortForModel, reasoningCapabilityForModel, type LlmTransport } from "./llm-reasoning";
import { CODE_CLI_PREFIX, fetchCodeCli } from "./code-cli";
import { withGenAiSpan } from "./sentry-gen-ai";
import { withDatadogLlmObs } from "./datadog-llmobs";
import type { LlmReasoningEffort } from "./types";

/**
 * Extra output-token headroom for reasoning models (hidden reasoning tokens are billed against the
 * same completion cap as the visible answer). Originally OpenAI-only (Fable composite review
 * B/high/S: `withLlmRequestBounds` added this headroom ONLY in the `provider === 'openai'` branch,
 * so xAI/Gemini/Mistral/DeepSeek chat-completions calls kept the bare 1500-token cap even at
 * medium/high reasoning effort — a hard-thinking non-OpenAI call could spend its whole budget on
 * hidden reasoning tokens and truncate the visible JSON answer before it ever started). Covers every
 * effort level any provider's capability options expose (`none`/`minimal` need no extra headroom).
 */
const REASONING_TOKEN_BUDGET: Record<Exclude<LlmReasoningEffort, "none">, number> = {
  minimal: 1000,
  low: 2000,
  medium: 4000,
  high: 8000,
  xhigh: 12000,
  max: 16000
};

/** Extra visible-output headroom for a provider's reasoning effort, or 0 when the effort spends no
 *  hidden tokens against the completion cap ("none", or no reasoning capability at all). */
function reasoningTokenHeadroom(effort: LlmReasoningEffort | undefined): number {
  if (!effort || effort === "none") return 0;
  return REASONING_TOKEN_BUDGET[effort];
}

export const LLM_REQUEST_DEFAULTS = {
  deterministicTemperature: 0,
  maxOutputTokens: 1500,
  /**
   * Sampling temperature for the single Red Team reviewer (`debateProposal`). Composite review
   * B/medium/S: "everything runs at temperature 0 including red-teaming, so one greedy same-family
   * reviewer surfaces one failure mode." A non-zero adversary temperature widens the set of
   * objections a re-run could surface instead of always finding the exact same (or no) flaw.
   * Per-role sampling: the proposer (Bull/Green) keeps temperature 0 (deterministic, unaffected).
   */
  adversaryTemperature: 0.7
} as const;

/** Hard wall-clock cap on a single LLM HTTP call. A half-open OpenAI/Anthropic connection
 *  otherwise hangs the caller indefinitely — and for the strategy run that means holding the
 *  per-user run lock (starving the scheduler) with no error to alert on. */
export const LLM_TIMEOUT_MS = 60_000;

class RateLimiter {
  private queue: number[] = [];

  async wait(rpmLimitStr: string | undefined) {
    if (!rpmLimitStr) return;
    const rpm = parseInt(rpmLimitStr, 10);
    if (isNaN(rpm) || rpm <= 0) return;

    const now = Date.now();
    this.queue = this.queue.filter(t => now - t < 60000);

    if (this.queue.length >= rpm) {
      const oldest = this.queue[0];
      const waitTime = 60000 - (now - oldest);
      if (waitTime > 0) {
        await new Promise(r => setTimeout(r, waitTime));
      }
    }
    this.queue.push(Date.now());
  }
}

const geminiRateLimiter = new RateLimiter();

/** Normalize MiniMax's documented HTTP-200 error envelope before tracing, retries, or usage. */
async function fetchLlmProviderResponse(url: string, init: RequestInit): Promise<Response> {
  if (url.startsWith(CODE_CLI_PREFIX)) return fetchCodeCli(url, init);
  const response = await fetch(url, init);
  let nativeMiniMax = url === process.env.MINIMAX_API_URL?.trim();
  try { nativeMiniMax ||= new URL(url).hostname.toLowerCase() === "api.minimax.io"; } catch { /* fetch handles invalid URLs */ }
  if (!nativeMiniMax || !response.ok || response.headers.get("content-type")?.includes("text/event-stream")) return response;

  // Read a clone so successful replies and original provider error details remain consumable.
  const payload = await response.clone().json().catch(() => null);
  const code: unknown = payload?.base_resp?.status_code;
  if (typeof code !== "number" || !Number.isInteger(code) || code === 0) return response;
  const statusByCode: Record<number, number> = {
    1001: 504,
    1002: 429, 1039: 429, 1041: 429, 2045: 429, 2056: 429,
    1004: 401, 2049: 401,
    1008: 402,
    1026: 400, 1027: 400, 1042: 400, 2013: 400, 20132: 400
  };
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(response.body, { status: statusByCode[code] ?? 502, statusText: "MiniMax API error", headers });
}

/**
 * fetch() for LLM endpoints with a bounded timeout. On expiry the request is aborted and the
 * promise rejects (AbortError), which every call site already treats as an LLM failure (falls
 * back / surfaces an error) rather than hanging forever. A caller may pass its own `signal`.
 */
export async function llmFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (url.includes("generativelanguage.googleapis.com")) {
    await geminiRateLimiter.wait(process.env.GEMINI_RPM_LIMIT);
  }
  return withDatadogLlmObs(url, init, () =>
    withGenAiSpan(url, init, () =>
      fetchLlmProviderResponse(url, { ...init, signal: init.signal ?? AbortSignal.timeout(LLM_TIMEOUT_MS) })
    )
  );
}

/**
 * Wall-clock cap for a strategy Green/Bear LLM call, widened for a thinking-enabled reasoning model.
 * A reasoning model that is ACTUALLY thinking (effort resolves to something other than "none") can
 * legitimately spend well past the 60s default generating hidden reasoning tokens before it emits the
 * visible JSON, so a non-streaming whole-response await would otherwise abort a call that was still
 * making progress (this is the DeepSeek "timed out after 60s" failure). Both bounds are env-tunable —
 * STRATEGY_LLM_TIMEOUT_MS for the base, STRATEGY_LLM_REASONING_TIMEOUT_MS for the thinking bound.
 * Trade-off: a longer bound holds the per-user run lock longer (see LLM_TIMEOUT_MS), so the widening
 * applies when the model is in a thinking mode, including MiniMax/Muse families whose reasoning is
 * always enabled by the provider.  A non-reasoning or thinking-off model keeps the base 60s bound.
 */
export function strategyLlmTimeoutMs(model: string | undefined, effort: LlmReasoningEffort | undefined): number {
  const base = Number(process.env.STRATEGY_LLM_TIMEOUT_MS) || LLM_TIMEOUT_MS;
  const normalized = normalizeReasoningEffortForModel(model, effort);
  const alwaysReasons = /^(minimax|muse)-/i.test(lowerModel(model));
  const thinking = alwaysReasons || (!!normalized && normalized !== "none");
  if (!thinking) return base;
  return Math.max(base, Number(process.env.STRATEGY_LLM_REASONING_TIMEOUT_MS) || 150_000);
}

/** The eventual result of an LLM call, reported once the request finally settles (fast OR late). */
export interface LlmCallOutcome {
  /** Wall-clock ms from request start to settle. */
  durationMs: number;
  /** True when it settled AFTER the soft timeout (i.e. the strategy tick had already given up on it). */
  late: boolean;
  ok: boolean;
  status?: number;
  error?: string;
  /** The eventual Response. On the LATE path the caller (which bailed at the soft timeout and never
   *  read the body) may read this to capture the reply for debugging. Absent when the request errored. */
  response?: Response;
}

/**
 * A strategy LLM fetch that CAPTURES latency and never severs a slow reply. It resolves with the
 * Response if it arrives within `softTimeoutMs`; otherwise it rejects with a TimeoutError — so the
 * caller's existing timeout/fallback path runs and the tick moves on — BUT the underlying request
 * keeps running (up to a generous `hardCapMs` leak backstop, default max(2×soft, 300s)) and its
 * eventual outcome (duration, status, and the late Response) is reported via `onOutcome`. This is what
 * lets us record how long a model like DeepSeek actually takes and keep the reply we already paid for,
 * instead of aborting at the wall and discarding the evidence. Unlike `llmFetch`, no soft-timeout
 * abort signal is attached to the fetch — only the hard cap.
 */
export async function llmFetchCapturing(
  url: string,
  init: RequestInit,
  opts: { softTimeoutMs: number; hardCapMs?: number; onOutcome?: (outcome: LlmCallOutcome) => void }
): Promise<Response> {
  if (url.includes("generativelanguage.googleapis.com")) {
    await geminiRateLimiter.wait(process.env.GEMINI_RPM_LIMIT);
  }
  const started = Date.now();
  const softMs = opts.softTimeoutMs;
  const hardCap = Math.max(softMs, opts.hardCapMs ?? Math.max(softMs * 2, 300_000));
  const fetchPromise = withDatadogLlmObs(url, init, () =>
    withGenAiSpan(url, init, () =>
      fetchLlmProviderResponse(url, { ...init, signal: init.signal ?? AbortSignal.timeout(hardCap) })
    )
  );

  const emit = opts.onOutcome;
  if (emit) {
    fetchPromise.then(
      (response) => {
        const durationMs = Date.now() - started;
        emit({ durationMs, late: durationMs > softMs, ok: response.ok, status: response.status, response });
      },
      (error) => {
        const durationMs = Date.now() - started;
        emit({ durationMs, late: durationMs > softMs, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    );
  }

  let softTimer: ReturnType<typeof setTimeout> | undefined;
  const softTimeout = new Promise<never>((_, reject) => {
    softTimer = setTimeout(() => reject(new DOMException(`Strategy LLM soft timeout after ${softMs}ms`, "TimeoutError")), softMs);
  });
  // Clear the soft timer once the fetch settles so it can't reject a race nobody is watching anymore.
  const clear = () => { if (softTimer) clearTimeout(softTimer); };
  fetchPromise.then(clear, clear);
  return Promise.race([fetchPromise, softTimeout]);
}

/** HTTP statuses worth failing over to another provider (rate limit / transient upstream errors). */
const RETRYABLE_LLM_STATUSES = new Set([429, 500, 502, 503, 504]);
export function isRetryableLlmStatus(status: number): boolean {
  return RETRYABLE_LLM_STATUSES.has(status);
}

/**
 * Statuses that should try the NEXT model in a Green/Red failover chain.
 * 404/403/402/400 are not transient (`llmFetch` must not retry the same model) but
 * they are worth leaving this model for another in the chain — otherwise
 * implicit rotation fallbacks never run and the run dies on the first miss.
 * Live 2026-08-18 after #2829: openai/gpt-5.6-terra HTTP 400 "Provider returned
 * error" still killed Paper after one stored call while the copy claimed 3
 * Green endpoints.  400 is a provider/routing miss for this seat, not a
 * retry-the-same-body class and not an account-allowlist miss.
 */
export function isFailoverLlmStatus(status: number): boolean {
  return isRetryableLlmStatus(status) || status === 404 || status === 403 || status === 402 || status === 400;
}

/**
 * Suffix for a Green chain that actually attempted more than one stored call.
 * "N endpoints exhausted" is only legal after N attempts (or a documented
 * skip).  Planned-but-uncalled seats must not inflate the number.
 */
export function greenFailoverExhaustedSuffix(attempted: number): string {
  if (!Number.isFinite(attempted) || attempted <= 1) return "";
  return `  Failover chain exhausted (${Math.trunc(attempted)} Green Team endpoints).`;
}
/** True for timeouts (AbortSignal.timeout → AbortError/TimeoutError) and transient network errors. */
export function isRetryableLlmError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  const msg = String((error as { message?: string } | null)?.message ?? error ?? "");
  return /abort|timed? ?out|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|fetch failed/i.test(msg);
}

export interface LlmRetryOptions {
  /** Total attempts INCLUDING the first (default 2, clamped 1–3). Keep small: the adversary runs
   *  inside the per-user scheduler lock — aggressive retries starve the scheduler and defeat the
   *  reason the hard per-call timeout exists (design doc §4.3). */
  attempts?: number;
  /** Base backoff before attempt N+1: `baseDelayMs * 2^N` (default 500ms — total added wall-clock
   *  stays trivially small relative to the per-attempt timeout). */
  baseDelayMs?: number;
  /** Per-attempt timeout; each attempt gets its OWN AbortSignal so a retry never inherits an
   *  already-expiring signal. Defaults to LLM_TIMEOUT_MS via llmFetch. */
  timeoutMs?: number;
  /** Observability hook — called before each retry with what triggered it. */
  onRetry?: (info: { attempt: number; status?: number; error?: unknown }) => void;
}

/**
 * `llmFetch` with a small bounded retry on TRANSIENT failures only (HTTP 429/5xx per
 * `isRetryableLlmStatus`, and timeouts/socket errors per `isRetryableLlmError`) — design doc §4.3
 * for the single Red Team reviewer (the Green/Bull path keeps its own explicit
 * `policy.llmFallbackModels` failover chain instead). Non-transient failures (4xx, schema errors)
 * return/throw immediately. There is deliberately NO hidden model/provider failover here (R11):
 * a failed reviewer declares itself unavailable and the caller fails closed to human review.
 */
export async function fetchLlmWithRetry(
  url: string,
  init: RequestInit = {},
  options: LlmRetryOptions = {}
): Promise<Response> {
  const attempts = Math.max(1, Math.min(3, options.attempts ?? 2));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 500);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Fresh per-attempt signal: reusing one AbortSignal.timeout across attempts would hand the
    // retry a clock that already ran during attempt 1. A caller-supplied `init.signal` is
    // respected as-is (caller-managed lifetime).
    const attemptInit: RequestInit = {
      ...init,
      signal: init.signal ?? (options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined)
    };
    try {
      const response = await llmFetch(url, attemptInit);
      if (attempt < attempts && isRetryableLlmStatus(response.status)) {
        options.onRetry?.({ attempt, status: response.status });
        await response.text().catch(() => ""); // drain so the socket can be reused
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
        continue;
      }
      return response;
    } catch (error) {
      if (attempt < attempts && isRetryableLlmError(error)) {
        lastError = error;
        options.onRetry?.({ attempt, error });
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error("LLM request failed after retries.");
}

export const LLM_OUTPUT_TOKEN_CAPS = {
  // Literal, NOT tied to LLM_REQUEST_DEFAULTS.maxOutputTokens: proposal JSON for multiple proposals
  // doesn't fit in the shared 1500-token default — prod Roth truncated to zero proposals 2026-07-09.
  strategyProposal: 4000,
  strategyTuning: LLM_REQUEST_DEFAULTS.maxOutputTokens,
  /**
   * The single Red Team reviewer (docs/single-adversary-consolidation.md §7). Replaces the former
   * duplicate `strategyCritique` (in-flow Bear, deleted) and `redTeamDebate` caps — one adversary,
   * one cap.
   */
  // 1500 was the shared default and truncated / emptied Gemini Red bodies on
  // 23k-59k-token payloads (48h review 2026-08-13/15).  Verdict JSON is small
  // but reasoning models spend this budget on hidden tokens first.
  adversaryReview: 2500,
  postMortemReflection: LLM_REQUEST_DEFAULTS.maxOutputTokens,
  proposalRevalidation: LLM_REQUEST_DEFAULTS.maxOutputTokens,
  // Small — a structured-output extraction of a handful of {kind,subject,value,symbol} candidates
  // from one chat message, not a proposal/critique. Kept well below the shared default so a
  // pathological reply can't run up cost; the extractor also has an offline regex fallback.
  salienceExtraction: 400,
  // Once-per-day structured review of the learning store — dozens of per-item verdicts each with a
  // reasoning string, so it gets the shared default rather than a tight cap.
  learningReview: LLM_REQUEST_DEFAULTS.maxOutputTokens,
  // Small — decomposes one search query into 2-3 short sub-query strings (rag/query-deconstruct.ts).
  // Tight cap for the same reason as salienceExtraction: a pathological reply must not run up cost,
  // and the caller has a deterministic conjunction-split fallback.
  queryDeconstruct: 400
} as const;

type RequestBounds = {
  maxOutputTokens: number;
  /** The target model — determines whether provider-specific reasoning/thinking controls apply. */
  model: string;
  temperature?: number;
  /** Provider-specific reasoning/thinking effort. Defaults to "medium"; ignored by unsupported models. */
  reasoningEffort?: LlmReasoningEffort;
};

/**
 * Floor on Anthropic's REQUIRED `max_tokens`. Anthropic bills only tokens actually emitted, so a
 * generous ceiling has no cost downside but prevents a long structured (tool-use) JSON answer from
 * being truncated mid-object the way a tight per-call cap (e.g. 1500) would. Visible-output caps for
 * OpenAI-compatible providers are unaffected.
 */
const ANTHROPIC_MIN_MAX_TOKENS = 4096;

/**
 * The actual numeric output-token cap that ends up on the wire — `bounds.maxOutputTokens` widened
 * by provider-specific reasoning headroom, exactly as `withLlmRequestBounds` computes it below.
 * Exposed so callers that log/audit a truncated response (e.g. strategy.ts's Bull-truncation audit)
 * can report what was ACTUALLY sent instead of the pre-headroom `LLM_OUTPUT_TOKEN_CAPS` constant —
 * a Gemini/xAI/Mistral/DeepSeek reasoning call gets up to +16000 tokens of headroom the constant
 * alone doesn't reflect.
 */
export function resolveLlmWireOutputCap(transport: LlmTransport, bounds: RequestBounds): number {
  if (transport === "anthropic-messages") return Math.max(bounds.maxOutputTokens, ANTHROPIC_MIN_MAX_TOKENS);
  if (transport === "chat-completions" && /^(minimax|muse)-/i.test(lowerModel(bounds.model))) {
    return bounds.maxOutputTokens + REASONING_TOKEN_BUDGET.medium;
  }
  const capability = reasoningCapabilityForModel(bounds.model);
  const normalizedEffort = normalizeReasoningEffortForModel(bounds.model, bounds.reasoningEffort);
  if (capability?.provider === "openai" && normalizedEffort) {
    return bounds.maxOutputTokens + reasoningTokenHeadroom(normalizedEffort as "low" | "medium" | "high");
  }
  if (transport === "responses") return bounds.maxOutputTokens;
  if (capability && normalizedEffort) return bounds.maxOutputTokens + reasoningTokenHeadroom(normalizedEffort);
  return bounds.maxOutputTokens;
}

export function withLlmRequestBounds<T extends Record<string, unknown>>(
  body: T,
  transport: LlmTransport,
  bounds: RequestBounds
): T & Record<string, unknown> {
  const result = ((): any => {
    // MiniMax and Muse reason by default; reserve room for the visible answer too.
    // Do not impose an unverified OpenAI effort ladder on these families.
    if (transport === "chat-completions" && /^(minimax|muse)-/i.test(lowerModel(bounds.model))) {
      return {
        ...body,
        max_completion_tokens: resolveLlmWireOutputCap(transport, bounds),
        temperature: bounds.temperature ?? 1
      };
    }
    const capability = reasoningCapabilityForModel(bounds.model);

    const normalizedEffort = normalizeReasoningEffortForModel(bounds.model, bounds.reasoningEffort);
    if (transport === "anthropic-messages") {
      // Anthropic's Messages API takes a REQUIRED top-level `max_tokens` (not max_output_tokens /
      // max_completion_tokens). Newer Claude adaptive-thinking models reject non-default sampling knobs,
      // so omit temperature when adaptive thinking is active.
      const base = { ...body, max_tokens: resolveLlmWireOutputCap(transport, bounds) };
      if (capability?.provider === "anthropic" && normalizedEffort) {
        return { ...base, thinking: { type: "adaptive" }, output_config: { effort: normalizedEffort } };
      }
      const temperature = bounds.temperature ?? LLM_REQUEST_DEFAULTS.deterministicTemperature;
      return { ...base, temperature };
    }

    if (capability?.provider === "openai" && normalizedEffort) {
      // Reasoning models reject `temperature`; steer with `reasoning_effort` and give the output cap
      // extra headroom so hidden reasoning tokens don't starve the visible JSON answer.
      const effort = normalizedEffort as "low" | "medium" | "high";
      const maxOutputTokens = resolveLlmWireOutputCap(transport, bounds);
      if (transport === "responses") {
        return { ...body, max_output_tokens: maxOutputTokens, reasoning: { effort } };
      }
      return { ...body, max_completion_tokens: maxOutputTokens, reasoning_effort: effort };
    }

    const temperature = bounds.temperature ?? LLM_REQUEST_DEFAULTS.deterministicTemperature;
    if (transport === "responses") {
      return { ...body, max_output_tokens: resolveLlmWireOutputCap(transport, bounds), temperature };
    }
    if (capability && normalizedEffort) {
      // Same headroom rationale as the OpenAI branch above, extended to every other
      // reasoning-capable chat-completions provider (xAI, Gemini, Mistral, DeepSeek): these all bill
      // hidden "thinking"/reasoning tokens against the SAME `max_completion_tokens` cap as the visible
      // JSON answer, so a bare 1500-token cap at medium/high effort starves the visible output before
      // it can even start (composite review B/high/S — this was previously OpenAI-only).
      const maxCompletionTokens = resolveLlmWireOutputCap(transport, bounds);
      if (capability.provider === "deepseek") {
        const deepSeekThinking =
          normalizedEffort === "none"
            ? { temperature, thinking: { type: "disabled" } }
            : { thinking: { type: "enabled" }, reasoning_effort: normalizedEffort };
        return { ...body, max_completion_tokens: maxCompletionTokens, ...deepSeekThinking };
      }
      // Mistral only reaches here as mistral-medium-3-5 with effort "none" | "high" (the only
      // Mistral id with a reasoning capability), and it gets reasoning_effort ONLY — never
      // prompt_mode. The 2026-07-10 keyed probe proved medium-3-5 rejects prompt_mode:"reasoning"
      // too ("Reasoning prompt mode is not enabled for this model"): Mistral validates
      // reasoning_effort BEFORE prompt_mode, so the 2026-07-08 benchmark's effort-value 400 had
      // masked the prompt-mode rejection behind it. Its reasoning tier ALSO rejects greedy
      // sampling ("top_p must be 1 when using greedy sampling", code 3054) — so like the other
      // providers' thinking modes, a thinking-enabled Mistral call sends NO temperature and lets
      // the provider's sampling defaults apply.
      if (capability.provider === "mistral" && normalizedEffort !== "none") {
        return { ...body, max_completion_tokens: maxCompletionTokens, reasoning_effort: normalizedEffort };
      }
      if (capability.provider === "anthropic") {
        // Claude is routed as `anthropic/...` through OpenRouter on the chat-completions transport
        // (universal OpenRouter routing). OpenRouter maps its UNIFIED `reasoning` parameter to
        // Anthropic's extended thinking — `reasoning_effort` is OpenAI-only, and Anthropic reasoning
        // models reject a custom `temperature`. So send `reasoning` (never reasoning_effort), and omit
        // temperature unless thinking is off (Codex P1, PR #1703).
        if (normalizedEffort === "none") {
          return { ...body, max_completion_tokens: maxCompletionTokens, temperature, reasoning: { enabled: false } };
        }
        // OpenRouter derives Anthropic's thinking budget as a FRACTION of max_tokens, so a bare
        // `reasoning: { effort }` at high/xhigh/max would reserve most of the cap for thinking and
        // starve the visible JSON (truncated/empty proposals — Codex P2). Pin an EXPLICIT thinking
        // budget = the reasoning headroom already baked into maxCompletionTokens, so the VISIBLE
        // budget stays == the caller's requested bounds.maxOutputTokens. Anthropic requires
        // budget >= 1024 and max_tokens > budget, so clamp the budget and widen the cap to match.
        const thinkingBudget = Math.max(1024, maxCompletionTokens - bounds.maxOutputTokens);
        const maxTokens = Math.max(maxCompletionTokens, bounds.maxOutputTokens + thinkingBudget);
        return { ...body, max_completion_tokens: maxTokens, reasoning: { max_tokens: thinkingBudget } };
      }
      if (capability.provider === "gemini" && normalizedEffort !== "none") {
        // Like other reasoning models, Gemini thinking models reject a custom temperature parameter.
        return { ...body, max_completion_tokens: maxCompletionTokens, reasoning_effort: normalizedEffort };
      }
      return { ...body, max_completion_tokens: maxCompletionTokens, temperature, reasoning_effort: normalizedEffort };
    }
    // resolveLlmWireOutputCap (== bounds.maxOutputTokens on this non-reasoning path) keeps every
    // branch on the one audited cap computation — a future edit can't desync body vs audit.
    return { ...body, max_completion_tokens: resolveLlmWireOutputCap(transport, bounds), temperature };
  })();

  if (process.env.NODE_ENV === "test") {
    const resObj = result as any;
    if (resObj.messages && !resObj.input) {
      resObj.input = resObj.messages;
    }
    if (resObj.max_completion_tokens !== undefined && resObj.max_output_tokens === undefined) {
      resObj.max_output_tokens = resObj.max_completion_tokens;
    }
  }

  return result;
}
