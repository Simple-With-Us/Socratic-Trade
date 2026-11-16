// llm-late-usage.ts — one place that turns an `llmFetchCapturing` outcome into BOTH observability
// and money.
//
// WHY THIS EXISTS.  `llmFetchCapturing` (llm-request.ts) deliberately does NOT sever a slow LLM
// request at the soft timeout: the strategy tick gives up and fails over, but the original request
// keeps running to the hard cap (up to 300s) and the provider bills the FULL reasoning completion
// it eventually produces.  Before this module the late reply was written to an `llm_late_response`
// audit and then dropped on the floor — never metered.  Only the FAILOVER call reached
// `llm_usage`, so /console/usage and `checkLlmDailyBudget` were blind to the single most expensive
// call class in the app (a frontier reasoning seat that timed out AND was paid for), and the same
// run then paid a second time for the model that answered.  Red Team was worse: its
// `llmFetchCapturing` had no `onOutcome` at all, so a late reviewer reply produced neither an
// audit nor a ledger row.
//
// The ledger rows this writes carry a distinct `context` suffix (`-late`) precisely so the Usage
// page can show them as their own line: they are real spend for an answer the run did not use.
import { audit } from "./db";
import { extractLlmText } from "./llm-call";
import type { LlmCallOutcome } from "./llm-request";
import { extractLlmUsage, providerRequestIdFromPayload, recordLlmUsage } from "./llm-usage";
import type { LlmKeySource } from "./db-api-keys";

export interface LateLlmCallContext {
  runId?: string;
  userId: string;
  /** Which lane paid for the call — "bull" / "bear" / "red".  Recorded on the audits. */
  step: string;
  provider: string;
  model: string;
  /** The soft wall the tick actually gave this call, recorded so the timeout can be tuned from data. */
  softTimeoutMs: number;
  connectedAccountId?: string;
  /** Key attribution for the ledger row — same values the fast path passes to `recordLlmUsage`. */
  keySource: Exclude<LlmKeySource, "none">;
  keyRef?: string;
  /**
   * `recordLlmUsage` context tag for the LATE row, e.g. "strategy-late" / "red-team-late".  Keep
   * the `-late` suffix: it is what distinguishes abandoned spend from spend the run consumed.
   */
  usageContext: string;
}

/** Max characters of the late reply kept on the audit — enough to see what was paid for. */
const LATE_TEXT_SNIPPET_CHARS = 4000;

/**
 * Record the outcome of one capturing LLM call.  Always writes an `llm_call_latency` audit (fast
 * or late).  On the LATE path it additionally drains the response body ONCE to write an
 * `llm_late_response` audit AND meter the call through `recordLlmUsage`.
 *
 * Only the LATE path may read the body: on a FAST settle the normal flow owns the response and a
 * second read would race it.  That invariant predates this module and must be preserved.
 *
 * Returns a promise that resolves when the late capture finishes, so tests can await it.  Callers
 * on the hot path fire and forget — nothing here may block or throw into a run.
 */
export function recordLlmCallOutcome(outcome: LlmCallOutcome, ctx: LateLlmCallContext): Promise<void> {
  audit(
    "llm_call_latency",
    {
      runId: ctx.runId,
      step: ctx.step,
      provider: ctx.provider,
      model: ctx.model,
      durationMs: outcome.durationMs,
      softTimeoutMs: ctx.softTimeoutMs,
      late: outcome.late,
      ok: outcome.ok,
      status: outcome.status,
      error: outcome.error
    },
    ctx.userId,
    ctx.connectedAccountId
  );
  if (!outcome.late) return Promise.resolve();
  return (async () => {
    try {
      let textSnippet: string | undefined;
      let usage: ReturnType<typeof extractLlmUsage> | undefined;
      if (outcome.response) {
        const payload = await outcome.response.json().catch(() => undefined);
        if (payload) {
          const text = extractLlmText(payload);
          textSnippet = typeof text === "string" && text ? text.slice(0, LATE_TEXT_SNIPPET_CHARS) : undefined;
          usage = extractLlmUsage(payload);
          // Meter BEFORE the audit: an audit failure must not be what decides whether spend is
          // counted.  A late reply with no usage block still gets a row (calls are countable even
          // when tokens are not) so the call itself is never invisible.
          recordLlmUsage({
            userId: ctx.userId,
            provider: ctx.provider,
            model: ctx.model,
            context: ctx.usageContext,
            keySource: ctx.keySource,
            keyRef: ctx.keyRef,
            connectedAccountId: ctx.connectedAccountId,
            providerRequestId: providerRequestIdFromPayload(ctx.provider, payload),
            ...usage
          });
        }
      }
      audit(
        "llm_late_response",
        {
          runId: ctx.runId,
          step: ctx.step,
          provider: ctx.provider,
          model: ctx.model,
          durationMs: outcome.durationMs,
          late: outcome.late,
          ok: outcome.ok,
          status: outcome.status,
          error: outcome.error,
          textSnippet,
          usage,
          metered: usage !== undefined
        },
        ctx.userId,
        ctx.connectedAccountId
      );
    } catch (err) {
      audit(
        "llm_late_response_capture_error",
        { runId: ctx.runId, step: ctx.step, error: err instanceof Error ? err.message : String(err) },
        ctx.userId,
        ctx.connectedAccountId
      );
    }
  })();
}
