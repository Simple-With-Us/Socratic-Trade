import { resolveRequestUserId } from "@/lib/request-user";
import { buildProductionDeps, makeOrchestrator } from "@/lib/chat/orchestrator";
import {
  AnthropicLLM,
  chatProviderForModel,
  getLLM,
  llmForModel,
  MockLLM,
  OpenAILLM,
  type ChatProvider,
  type LlmUsageOpts
} from "@/lib/chat/llm";
import { resolveLlmCredential } from "@/lib/db";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { isOverLlmBudget } from "@/lib/llm-budget";
import { LLM_REQUIRED_CHAT_MESSAGE } from "@/lib/llm-required";
import { DEFAULT_OPENAI_MODEL } from "@/lib/llm-request";
import { NextResponse } from "next/server";

/** The explicit offline path: the deterministic MockLLM, intentionally keyless. Anything else is a real
 *  provider and must resolve a credential. An empty/absent hint is NOT mock — it falls to a real env
 *  default, so it stays gated. */
function isOfflineMockRequest(modelHint: string | undefined, providerHint: string | undefined): boolean {
  return modelHint?.toLowerCase() === "mock" || providerHint === "mock";
}

/**
 * Resolve the chat provider this request will ACTUALLY call, mirroring the LLM-selection precedence
 * below: an explicit model routes to its provider (chatProviderForModel), else a legacy provider hint
 * (openai/anthropic) is used directly, else the env-configured default (CHAT_LLM, default openai).
 * The 412 gate checks THIS provider's credential — not "any provider" — so an Anthropic-only user who
 * lands on the default OpenAI model is blocked instead of silently degrading to MockLLM.
 */
function resolveChatProvider(modelHint: string | undefined, providerHint: string | undefined): ChatProvider {
  if (modelHint) return chatProviderForModel(modelHint);
  if (providerHint === "openai" || providerHint === "anthropic") return providerHint;
  return process.env.CHAT_LLM === "anthropic" ? "anthropic" : "openai";
}

export const dynamic = "force-dynamic";

function usageOpts(userId: string, source: "user" | "operator" | "none", keyRef?: string): LlmUsageOpts {
  return { userId, keySource: source === "operator" ? "operator" : "user", keyRef, context: "chat" };
}

/**
 * Build an LLM from the per-request provider hint, scoped to `userId`. The key resolves
 * per-user-first with the operator env key as a flag-gated failover (resolveLlmCredential), and
 * usage is attributed to the user (per attached key). Returns null for an unrecognized hint so the
 * caller falls through to the env default (also per-user via getLLM(userId)).
 */
function llmFromProvider(hint: string | undefined, userId: string) {
  if (hint === "openai") {
    const { key, source, keyRef } = resolveLlmCredential("openai", userId);
    if (key) return new OpenAILLM(key, process.env.CHAT_LLM_MODEL ?? DEFAULT_OPENAI_MODEL, undefined, usageOpts(userId, source, keyRef));
  }
  if (hint === "anthropic") {
    const { key, source, keyRef } = resolveLlmCredential("anthropic", userId);
    if (key) return new AnthropicLLM(key, process.env.CHAT_LLM_MODEL ?? "claude-opus-4-8", undefined, usageOpts(userId, source, keyRef));
  }
  if (hint === "mock") return new MockLLM();
  return null;
}

export async function POST(request: Request) {
  // Identity comes from the trusted header (resolveRequestUserId ignores the body), so rate-limit
  // BEFORE parsing the request body — an over-limit caller must not be able to force server-side
  // JSON parsing/allocation of an oversized payload just to be rejected. Returns 429 + Retry-After.
  const userId = resolveRequestUserId(request);
  const limited = enforceRateLimit(userId, "chat", RATE_LIMITS.chat);
  if (limited) return limited;
  const body = (await request.json().catch(() => ({}))) as {
    message?: unknown;
    userId?: unknown;
    provider?: unknown;
    model?: unknown;
    clientTurnId?: unknown;
  };
  if (typeof body.message !== "string" || !body.message.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }
  // Optional idempotency key: the client generates one per send and REUSES it on Retry, so a retried
  // request doesn't record the user turn twice. Fail loud on a malformed value rather than silently
  // dropping the idempotency the caller asked for.
  let clientTurnId: string | undefined;
  if (body.clientTurnId !== undefined) {
    if (typeof body.clientTurnId !== "string" || !body.clientTurnId.trim() || body.clientTurnId.trim().length > 64) {
      return NextResponse.json({ error: "clientTurnId must be a non-empty string of at most 64 characters" }, { status: 400 });
    }
    clientTurnId = body.clientTurnId.trim();
  }

  const modelHint = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
  const providerHint = typeof body.provider === "string" ? body.provider : undefined;

  // Chat is LLM-driven: gate it on a resolvable credential FOR THE PROVIDER THIS REQUEST WILL CALL
  // (the user's own key OR the operator failover) — not "any provider". The explicit offline Mock model
  // is the only keyless path; a real-provider model (or no hint, which falls to a real env default)
  // requires that provider's key. Gating on the resolved provider (not userHasAnyLlmCredential) closes
  // the fail-loud hole where an Anthropic-only user on the default OpenAI model passed and llmForModel
  // silently returned MockLLM. Without the key we 412 with a clear "connect a provider" message.
  if (!isOfflineMockRequest(modelHint, providerHint)) {
    const provider = resolveChatProvider(modelHint, providerHint);
    if (!resolveLlmCredential(provider, userId).key) {
      return NextResponse.json({ error: "llm_credential_required", message: LLM_REQUIRED_CHAT_MESSAGE }, { status: 412 });
    }
    // Enforce the daily LLM/RAG budget ceiling on chat too (default OFF → no-op when no limit is set).
    // Without this, once a user is over budget the strategy/revalidation/reflection paths are blocked
    // but dashboard chat keeps spending — chat is a real LLM (and RAG) spender and must count too.
    if (isOverLlmBudget(userId)) {
      return NextResponse.json(
        { error: "llm_budget_exceeded", message: "Daily LLM budget ceiling reached — chat is paused until the next daily reset." },
        { status: 429 }
      );
    }
  }

  try {
    // Always per-user. Precedence: an explicit model (routed to its provider across all five
    // providers), else a legacy provider hint, else the env-configured default — each keyed to this
    // user. (No shared singleton — that would pin one user's key/attribution for everyone.)
    const llm = (modelHint ? llmForModel(modelHint, userId) : undefined) ?? llmFromProvider(providerHint, userId) ?? getLLM(userId);
    const orchestrate = makeOrchestrator(buildProductionDeps(), llm);
    const reply = await orchestrate({ userId, message: body.message, clientTurnId });
    return NextResponse.json(reply);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[chat] orchestrator error:", message);
    // Single-operator app: forward the actual error (e.g. "invalid_api_key") so the
    // operator can act on it. Not a multi-user SaaS where internal details must be hidden.
    return NextResponse.json({ error: "chat_failed", message }, { status: 500 });
  }
}
