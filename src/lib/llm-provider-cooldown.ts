// llm-provider-cooldown.ts — short-lived per-LLM-provider failure cooldown for the Green/Red
// failover chains (audit handoff 6b.4).
//
// PROBLEM: the Bull (strategy.ts) and Red Team (red-team.ts) failover chains iterate their
// fallback lists in the same order on EVERY run with no cross-run memory that a provider just
// 429'd. On a multi-provider quota-exhaustion day each run re-discovers the same dead providers
// (wasted attempts + latency), and there is no distinct "everything is exhausted" state. The
// existing api-circuit-breaker protects DATA providers only (it keys off api_health_log lanes,
// which LLM calls never write).
//
// DESIGN (advisory, observable, never gating):
// - When an LLM call fails with a rate/quota error, record a cooldown for that provider's
//   credential lane (provider + keySource, mirroring api-circuit-breaker's lane concept so a
//   user's own exhausted key never cools the operator failover lane, and vice versa; personal
//   'user' lanes are additionally scoped PER USER — one user's exhausted personal key never
//   cools another user's healthy personal key. Operator lanes stay global: one shared credential).
// - Tiered TTLs: a transient 429 gets a short cooldown (default 5 min); a hard billing /
//   insufficient_quota failure (already surfaced by llm-errors.ts's 429 branch, but treated
//   identically before this module) gets a long one (default 60 min). Both env-overridable.
// - Chain planning SKIPS providers in cooldown (each skip audited with its remaining TTL) —
//   but when EVERY attempt in a chain is cooling, the chain is attempted ANYWAY, reordered
//   least-recently-failed first. The cooldown can therefore never make a run strictly worse
//   than today's behavior (every attempt today is still attemptable); it only reorders and
//   short-circuits known-dead lanes while any live lane exists. A lucky recovery stays possible.
// - All-cooling emits ONE throttled "autonomy degraded" notification + exhaustion audit per
//   cooldown window (until the earliest active cooldown expires), not one per run. Normal
//   provider_degraded event type — no forced policy override; the per-run skip/exhaustion
//   audits carry full observability regardless of the user's notification preferences.
// - Persistence: createDurableMap (durable-state.ts, PR #1634) — the same standard the app now
//   uses for cross-restart rate/cooldown state, since a merge-to-main auto-deploy replaces the
//   container mid-day and an in-memory-only cooldown would forget the quota exhaustion it just
//   learned about. (The api-circuit-breaker predates durable-state and stays in-memory because
//   its durable signal already lives in api_health_log; LLM calls have no such log.)
// - Kill switch: LLM_PROVIDER_COOLDOWN_DISABLED=1 restores exact pre-cooldown behavior
//   (recording, planning, and alerts all become no-ops).
//
// RED TEAM SEMANTICS UNCHANGED: this module only avoids pointless retries. A Red chain whose
// providers are all cooling is still attempted (least-recently-failed first), so every
// fail-closed / unavailable-routing outcome is decided by exactly the same code as before.

import { audit } from "./db";
import { createDurableMap } from "./durable-state";
import { sendNotification } from "./notifications";

export type LlmCooldownKind = "transient" | "billing";

export interface LlmProviderCooldownRecord {
  /** Unix ms until which this lane is considered cooling. */
  until: number;
  /** Unix ms of the failure that set (or refreshed) the cooldown. */
  failedAt: number;
  kind: LlmCooldownKind;
  /** Short raw-ish reason (truncated) for audit/debug — never shown as if it were data. */
  detail?: string;
  model?: string;
}

// Lane key: operator lanes are "<provider> operator" (one shared credential — a global cooldown
// is correct); PERSONAL-key lanes are "<provider> user <userId>" (account boundary: user A's
// exhausted personal key must never cool user B's healthy personal key, and neither must cool
// the operator failover lane). Mirrors api-circuit-breaker's (service, keySource) lane concept,
// plus the per-user split for the per-user credential source.
const cooldowns = createDurableMap<LlmProviderCooldownRecord>("llm-provider-cooldown");
// Exhaustion-alert throttle: userId -> unix ms until which the "all providers cooling" alert is
// suppressed (the earliest active cooldown expiry at the time the alert fired).
const exhaustionAlerts = createDurableMap<number>("llm-provider-cooldown-alert");

function cooldownProvider(provider: string, model?: string | null): string {
  if (provider === "openrouter" && model && model.includes("/")) {
    const raw = model.split("/")[0];
    if (raw === "google") return "gemini";
    if (raw === "mistralai") return "mistral";
    return raw;
  }
  return provider;
}

function laneKey(provider: string, keySource?: string | null, userId?: string | null): string {
  // A 'user' keySource is a per-user credential — scope its cooldown to that user.
  if (keySource === "user") return `${provider} user ${userId ?? "local"}`;
  return `${provider} ${keySource ?? ""}`;
}

/** Env kill switch: LLM_PROVIDER_COOLDOWN_DISABLED=1 restores exact pre-cooldown behavior. */
export function llmProviderCooldownDisabled(): boolean {
  const v = (process.env.LLM_PROVIDER_COOLDOWN_DISABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** Cooldown TTL for a transient rate-limit 429. Env-tunable; default 5 min. */
export function llmTransientCooldownMs(): number {
  const v = Number(process.env.LLM_PROVIDER_COOLDOWN_TRANSIENT_MS ?? 5 * 60_000);
  return Number.isFinite(v) && v >= 0 ? v : 5 * 60_000;
}

/** Cooldown TTL for a hard billing/insufficient_quota failure. Env-tunable; default 60 min. */
export function llmBillingCooldownMs(): number {
  const v = Number(process.env.LLM_PROVIDER_COOLDOWN_BILLING_MS ?? 60 * 60_000);
  return Number.isFinite(v) && v >= 0 ? v : 60 * 60_000;
}

/**
 * Classify a provider failure as cooldown-worthy. Classify on the RAW provider body, never the
 * humanized string (humanizeLlmError folds billing and transient into one sentence containing
 * the word "billing", which would misclassify every 429 as a hard billing failure).
 * - "billing": hard out-of-money signals — OpenAI insufficient_quota / "exceeded your current
 *   quota ... billing", Anthropic credit-balance / configured usage-limit caps (which arrive as
 *   400s, not 429s — llm-errors.ts:110), payment_required.
 * - "transient": any other HTTP 429, or an explicit rate-limit body.
 * - undefined: everything else (5xx, timeouts, schema errors) — NOT cooldown-worthy; the
 *   chain's existing per-run retry/failover semantics own those.
 */
export function classifyLlmRateOrQuotaFailure(
  status: number | undefined,
  detail: string | undefined | null
): LlmCooldownKind | undefined {
  const text = (detail ?? "").toLowerCase();
  if (/insufficient_quota|exceeded your current quota|billing|credit balance|out of credit|payment required|usage limit/.test(text)) {
    return "billing";
  }
  if (status === 429) return "transient";
  if (/rate limit|rate_limit|too many requests|quota/.test(text)) return "transient";
  return undefined;
}

/**
 * Record an LLM provider failure. Only rate/quota failures (see classify above) set a cooldown;
 * anything else is a no-op returning undefined. Audited as `llm_provider_cooldown_set`.
 */
export function recordLlmProviderFailure(input: {
  provider: string;
  keySource?: string | null;
  status?: number;
  detail?: string | null;
  model?: string;
  step?: string;
  runId?: string;
  userId?: string;
  connectedAccountId?: string;
}): LlmCooldownKind | undefined {
  if (llmProviderCooldownDisabled()) return undefined;
  const kind = classifyLlmRateOrQuotaFailure(input.status, input.detail);
  if (!kind) return undefined;
  const now = Date.now();
  const ttlMs = kind === "billing" ? llmBillingCooldownMs() : llmTransientCooldownMs();
  const record: LlmProviderCooldownRecord = {
    until: now + ttlMs,
    failedAt: now,
    kind,
    ...(input.model ? { model: input.model } : {}),
    ...(input.detail ? { detail: input.detail.replace(/\s+/g, " ").slice(0, 240) } : {})
  };
  // Transient (rate/5xx) failures cool only the vendor sub-lane so a busy OpenAI-family primary
  // doesn't cool a healthy Gemini/Anthropic fallback. BILLING/credits failures, however, exhaust the
  // WHOLE OpenRouter credential (every vendor shares that one key) — so keep them on the credential
  // lane (input.provider, i.e. "openrouter"), which getLlmProviderCooldown checks for EVERY vendor
  // attempt. Otherwise the planner cools only the openai lane and immediately retries google/anthropic
  // on the same dead key (Codex P2, PR #1703).
  const provider = kind === "billing" ? input.provider : cooldownProvider(input.provider, input.model);
  try {
    cooldowns.set(laneKey(provider, input.keySource, input.userId), record);
    audit(
      "llm_provider_cooldown_set",
      {
        provider,
        keySource: input.keySource ?? null,
        kind,
        ttlMs,
        until: new Date(record.until).toISOString(),
        ...(input.status !== undefined ? { httpStatus: input.status } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.step ? { step: input.step } : {}),
        ...(input.runId ? { runId: input.runId } : {})
      },
      input.userId ?? "local",
      input.connectedAccountId
    );
  } catch (err) {
    // Advisory bookkeeping must never break the caller's failover path.
    console.error("[llm-provider-cooldown] failed to record cooldown:", err instanceof Error ? err.message : err);
  }
  return kind;
}

/** The active cooldown for a provider lane, or undefined when none (expired entries are pruned
 *  lazily). `userId` selects the per-user lane when keySource is 'user' (ignored for operator
 *  lanes, which are shared by design). */
export function getLlmProviderCooldown(
  provider: string,
  keySource?: string | null,
  userId?: string | null,
  now: number = Date.now(),
  model?: string | null
): { record: LlmProviderCooldownRecord; remainingMs: number } | undefined {
  if (llmProviderCooldownDisabled()) return undefined;
  // Check BOTH the OpenRouter credential lane (billing/whole-key cooldowns) and the vendor sub-lane
  // (transient rate/5xx). The credential lane dominates — a billing cooldown on the shared key must
  // block EVERY vendor attempt, not just the vendor that happened to trip it (Codex P2, PR #1703).
  const credLane = laneKey(provider, keySource, userId);
  const vendorLane = laneKey(cooldownProvider(provider, model), keySource, userId);
  let best: { record: LlmProviderCooldownRecord; remainingMs: number } | undefined;
  for (const key of vendorLane === credLane ? [credLane] : [credLane, vendorLane]) {
    const record = cooldowns.get(key);
    if (!record) continue;
    if (now >= record.until) {
      cooldowns.delete(key); // lazy prune
      continue;
    }
    const remainingMs = record.until - now;
    // Prefer the lane cooling the longest so the caller waits out the dominant block.
    if (!best || remainingMs > best.remainingMs) best = { record, remainingMs };
  }
  return best;
}

export interface LlmAttemptLane {
  provider: string;
  model: string;
  keySource?: string | null;
}

/**
 * Plan a failover chain around active cooldowns. Order-preserving filter of `attempts` to lanes
 * NOT in cooldown; each skip is audited (`llm_provider_cooldown_skip`, with remaining TTL). When
 * EVERY lane is cooling, returns ALL attempts reordered least-recently-failed first — the chain
 * is still attempted in full, so this can never refuse work today's code would have tried — and
 * emits one throttled exhaustion audit + notification per cooldown window. Never returns an
 * empty array for a non-empty input. Disabled (kill switch) => returns `attempts` unchanged.
 */
export function planLlmProviderAttempts<T extends LlmAttemptLane>(
  attempts: readonly T[],
  ctx: { step: string; runId?: string; userId?: string; connectedAccountId?: string }
): T[] {
  if (llmProviderCooldownDisabled() || attempts.length === 0) return [...attempts];
  const userId = ctx.userId ?? "local";
  const now = Date.now();
  try {
    const cooling: Array<{ attempt: T; record: LlmProviderCooldownRecord; remainingMs: number }> = [];
    const live: T[] = [];
    for (const attempt of attempts) {
      const state = getLlmProviderCooldown(attempt.provider, attempt.keySource, ctx.userId, now, attempt.model);
      if (state) cooling.push({ attempt, record: state.record, remainingMs: state.remainingMs });
      else live.push(attempt);
    }
    if (cooling.length === 0) return [...attempts];

    if (live.length > 0) {
      // Skip only what's cooling; the rest of the chain runs in its configured order.
      for (const { attempt, record, remainingMs } of cooling) {
        audit(
          "llm_provider_cooldown_skip",
          {
            step: ctx.step,
            provider: cooldownProvider(attempt.provider, attempt.model),
            keySource: attempt.keySource ?? null,
            model: attempt.model,
            kind: record.kind,
            remainingMs,
            until: new Date(record.until).toISOString(),
            ...(ctx.runId ? { runId: ctx.runId } : {})
          },
          userId,
          ctx.connectedAccountId
        );
      }
      return live;
    }

    // EVERY lane is cooling: attempt anyway, least-recently-failed first (best odds of a lucky
    // recovery), so the cooldown never makes things strictly worse than the pre-cooldown chain.
    const ordered = [...cooling].sort((a, b) => a.record.failedAt - b.record.failedAt).map((c) => c.attempt);
    const earliestExpiry = Math.min(...cooling.map((c) => c.record.until));
    const suppressUntil = exhaustionAlerts.get(userId) ?? 0;
    if (now >= suppressUntil) {
      exhaustionAlerts.set(userId, earliestExpiry);
      const providers = cooling.map((c) => ({
        provider: c.attempt.provider,
        keySource: c.attempt.keySource ?? null,
        model: c.attempt.model,
        kind: c.record.kind,
        remainingMs: c.remainingMs
      }));
      audit(
        "llm_provider_cooldown_exhausted",
        {
          step: ctx.step,
          providers,
          earliestRetryAt: new Date(earliestExpiry).toISOString(),
          ...(ctx.runId ? { runId: ctx.runId } : {})
        },
        userId,
        ctx.connectedAccountId
      );
      const title = "All LLM providers are rate-limited or out of quota - autonomy degraded";
      const body =
        `Every provider in the ${ctx.step} chain is in a failure cooldown after rate/quota errors ` +
        `(${providers.map((p) => `${p.provider}:${p.kind}`).join(", ")}). Attempts continue least-recently-failed first; ` +
        `the earliest cooldown lifts at ${new Date(earliestExpiry).toISOString()}. Check provider billing/limits if this persists.`;
      // Normal event type + normal enabled-events gate (no forced policy): the audit rows above
      // are the guaranteed record; the notification is best-effort and must never block planning.
      void sendNotification(
        { type: "provider_degraded", title, payload: { source: "llm-provider-cooldown", step: ctx.step, providers, earliestRetryAt: new Date(earliestExpiry).toISOString(), ...(ctx.runId ? { runId: ctx.runId } : {}) } },
        { userId, directBody: body }
      ).catch(() => {});
    }
    return ordered;
  } catch (err) {
    // Planning is advisory: any bookkeeping failure degrades to today's exact behavior.
    console.error("[llm-provider-cooldown] planning failed; using the unfiltered chain:", err instanceof Error ? err.message : err);
    return [...attempts];
  }
}

/** Test-only: clear all cooldown + alert-throttle state (memory and persisted rows). */
export function resetLlmProviderCooldownsForTests(): void {
  cooldowns.clear();
  exhaustionAlerts.clear();
}
