// Cost-aware feedback loop: read budget status from the API Usage Monitor and (Phase 1) alert on
// over-budget providers.
//
// PHASE 2 (force cheaper models / skip a cycle when over budget) is wired into `runStrategyOnce`
// (see strategy.ts's "Cost-aware budget feedback loop" + "Per-user/day LLM budget ceiling"
// comments) as of 2026-07-05:
//   - ADVISORY (always on when the monitor is configured, independent of the enforce flag): every
//     run stamps a `usage_budget_status` audit receipt and, when a provider is at warning/exceeded,
//     injects a `formatBudgetAdvisory` line into the Bull userContent next to `drawdownAdvisory` —
//     DATA for the agent, never a command.
//   - ENFORCEMENT (opt-in via USAGE_BUDGET_ENFORCE, default off): `evaluateBudgetForRun`'s decision
//     is applied at the per-user/day LLM budget choke point, BEFORE any LLM call and AFTER the
//     risk-reducing breakers — skip ends the run gracefully (audit + notifyBudgetSkip), downgrade
//     swaps `policy.llmModel`/`policy.redTeamLlmModel` on the in-memory run policy ONLY (never
//     persisted via setPolicy, so the next run reads the owner's configured model again).
//
// SAFETY / SELF-SUFFICIENCY:
//   - Reads are gated on the same config as the push (USAGE_MONITOR_BASE_URL + USAGE_INGEST_TOKEN);
//     when unset the monitor isn't consulted at all and App B behaves exactly as before.
//   - Enforcement (model downgrade / cycle skip) is additionally gated behind USAGE_BUDGET_ENFORCE
//     (default off) — Phase 1 (alerts + advisory) is the default when the monitor is configured.
//   - FAIL-OPEN: if the monitor is unreachable or returns an error, budget status is treated as
//     unknown and NO enforcement happens (App B keeps trading normally). The only visible effect of
//     an outage is the "usage-monitor" row on the admin connections-health page.
//   - Status is TTL-cached so a run never hammers the monitor.

import { logApiHealth } from "./db-health";
import { sendNotification } from "./notifications";
import { audit } from "./db";
import type { TradingPolicy } from "./types";
import { resolveOpenAiModel } from "./llm-request";
import { usageMonitorBaseUrl, usageMonitorToken, usageMonitorEnabled } from "./usage-monitor-push";
import { alertUsageLimitHit } from "./usage-limit-alerts";

// ── Contract (subset of the monitor's GET /api/budget-status response) ──────────

export type BudgetLevel = "ok" | "warning" | "exceeded" | "unconfigured";

export interface ProviderBudget {
  name: string;
  status: BudgetLevel;
  monthlyBudgetUsd: number | null;
  spentUsd: number;
  remainingUsd: number | null;
  percentUsed: number | null;
}

export interface BudgetStatus {
  generatedAt: string;
  month: string;
  providers: ProviderBudget[];
  summary: {
    totalBudgetUsd: number;
    totalSpentUsd: number;
    remainingUsd: number;
    percentUsed: number | null;
    overBudget: boolean;
    warning: boolean;
  };
}

// ── Config ──────────────────────────────────────────────────────────────────────

function flagOn(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function numEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Phase 2 enforcement (model downgrade / cycle skip). Default OFF. */
export function usageBudgetEnforceEnabled(): boolean {
  return flagOn(process.env.USAGE_BUDGET_ENFORCE);
}

/**
 * Token for the budget-status GET. The monitor accepts a dedicated `USAGE_READ_TOKEN` when set,
 * else the ingest token — mirror that here so a separate read token doesn't 401 every budget read.
 */
function budgetReadToken(): string | undefined {
  const read = (process.env.USAGE_READ_TOKEN ?? "").trim();
  return read.length > 0 ? read : usageMonitorToken();
}

function ttlMs(): number {
  return numEnv("USAGE_BUDGET_TTL_MS", 5 * 60_000);
}

function timeoutMs(): number {
  // Kept short: the enforce path awaits this at run entry, so a hung monitor must not stall a
  // scheduled cycle for long. Fail-open returns null after the timeout (no enforcement).
  return numEnv("USAGE_BUDGET_TIMEOUT_MS", 2500);
}

function alertCooldownMs(): number {
  return numEnv("USAGE_BUDGET_ALERT_COOLDOWN_MS", 6 * 60 * 60_000);
}

// ── Fetch + TTL cache (globalThis-pinned so HMR can't split it) ─────────────────

interface BudgetCacheHost {
  __usageBudgetCache?: { status: BudgetStatus; fetchedAt: number };
  __usageBudgetAlertSentAt?: Map<string, number>;
}
const cacheHost = globalThis as unknown as BudgetCacheHost;

function isBudgetLevel(v: unknown): v is BudgetLevel {
  return v === "ok" || v === "warning" || v === "exceeded" || v === "unconfigured";
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Defensive parse of the monitor response — tolerant of extra/missing fields. */
function parseBudgetStatus(json: unknown): BudgetStatus | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const rawProviders = Array.isArray(obj.providers) ? obj.providers : [];
  const providers: ProviderBudget[] = [];
  for (const raw of rawProviders) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.name !== "string") continue;
    providers.push({
      name: p.name,
      status: isBudgetLevel(p.status) ? p.status : "unconfigured",
      monthlyBudgetUsd: numOrNull(p.monthlyBudgetUsd),
      spentUsd: numOrNull(p.spentUsd) ?? 0,
      remainingUsd: numOrNull(p.remainingUsd),
      percentUsed: numOrNull(p.percentUsed),
    });
  }
  const summaryRaw = (obj.summary && typeof obj.summary === "object" ? obj.summary : {}) as Record<string, unknown>;
  return {
    generatedAt: typeof obj.generatedAt === "string" ? obj.generatedAt : new Date().toISOString(),
    month: typeof obj.month === "string" ? obj.month : "",
    providers,
    summary: {
      totalBudgetUsd: numOrNull(summaryRaw.totalBudgetUsd) ?? 0,
      totalSpentUsd: numOrNull(summaryRaw.totalSpentUsd) ?? 0,
      remainingUsd: numOrNull(summaryRaw.remainingUsd) ?? 0,
      percentUsed: numOrNull(summaryRaw.percentUsed),
      overBudget: summaryRaw.overBudget === true,
      warning: summaryRaw.warning === true,
    },
  };
}

async function fetchBudgetStatus(fetchImpl: typeof fetch = fetch): Promise<BudgetStatus | null> {
  const baseUrl = usageMonitorBaseUrl();
  const token = budgetReadToken();
  if (!baseUrl || !token) return null;
  const url = `${baseUrl}/api/budget-status`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  const start = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
      cache: "no-store",
    });
    logApiHealth({
      service: "usage-monitor",
      ok: res.ok,
      latencyMs: Date.now() - start,
      errorText: res.ok ? undefined : `budget-status HTTP ${res.status}`,
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return parseBudgetStatus(json);
  } catch (err) {
    logApiHealth({
      service: "usage-monitor",
      ok: false,
      latencyMs: Date.now() - start,
      errorText: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cached budget status. Returns null when the monitor is unconfigured or unreachable (fail-open —
 * callers must treat null as "unknown, do not enforce"). Successful fetches are cached for TTL.
 */
export async function getBudgetStatusCached(opts: { force?: boolean; fetchImpl?: typeof fetch } = {}): Promise<BudgetStatus | null> {
  if (!usageMonitorEnabled()) return null;
  const now = Date.now();
  const cached = cacheHost.__usageBudgetCache;
  if (!opts.force && cached && now - cached.fetchedAt < ttlMs()) return cached.status;
  const status = await fetchBudgetStatus(opts.fetchImpl);
  if (status) cacheHost.__usageBudgetCache = { status, fetchedAt: now };
  return status; // null on failure → fail-open
}

// ── Phase 1: alerts ──────────────────────────────────────────────────────────────

function shouldAlert(userId: string, provider: string, level: BudgetLevel): boolean {
  const map = cacheHost.__usageBudgetAlertSentAt ?? (cacheHost.__usageBudgetAlertSentAt = new Map());
  const key = `${userId}|${provider}|${level}`;
  const now = Date.now();
  const last = map.get(key);
  if (last !== undefined && now - last < alertCooldownMs()) return false;
  map.set(key, now);
  return true;
}

/**
 * Fire budget alerts through the existing notification pipe for any provider at warning/exceeded.
 * Best-effort, throttled per (user, provider, level). Never throws. Runs whenever the monitor is
 * configured (independent of the enforce flag).
 */
export async function checkBudgetAndAlert(
  userId: string,
  policy: TradingPolicy,
  deps: { status?: BudgetStatus | null; fetchImpl?: typeof fetch } = {}
): Promise<void> {
  try {
    if (!usageMonitorEnabled()) return;
    const status = deps.status ?? (await getBudgetStatusCached({ fetchImpl: deps.fetchImpl }));
    if (!status) return;
    for (const p of status.providers) {
      if (p.status !== "exceeded" && p.status !== "warning") continue;
      if (!shouldAlert(userId, p.name, p.status)) continue;
      await alertUsageLimitHit({
        userId,
        provider: p.name,
        operation: "usage-monitor.budget-status",
        limitName: "monthly usage budget",
        status: p.status === "exceeded" ? "exceeded" : "warning",
        used: p.spentUsd,
        limit: p.monthlyBudgetUsd,
        unit: "USD",
        recommendation:
          p.status === "exceeded"
            ? "If usage is intentional and useful, raise the provider budget. If not, inspect repeated calls, retries, model selection, and batching."
            : "Watch trend and decide whether to raise the budget or reduce usage before the provider blocks useful work.",
        payload: {
          spentUsd: p.spentUsd,
          monthlyBudgetUsd: p.monthlyBudgetUsd,
          remainingUsd: p.remainingUsd,
          percentUsed: p.percentUsed,
          month: status.month,
          policyConnectedAccountId: policy.connectedAccountId
        }
      });
    }
  } catch {
    /* alerts are best-effort — never break the caller */
  }
}

// ── Phase 2: enforcement (model downgrade / cycle skip) ─────────────────────────

/** Provider a model routes to — mirrors resolveLlmEndpoint's prefix logic. */
function providerForModel(model: string | null | undefined): string {
  const m = (model ?? "").toLowerCase();
  if (/^(claude|anthropic)/.test(m)) return "anthropic";
  if (/^grok/.test(m)) return "xai";
  if (/^gemini/.test(m)) return "gemini";
  if (/^(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)/.test(m)) return "mistral";
  if (/^deepseek/.test(m)) return "deepseek";
  return "openai";
}

// Cost-ordered downgrade within a provider family (keys/values exist in MODEL_PRICE_PER_M).
const CHEAPER_MODEL: Record<string, string> = {
  // OpenAI
  "gpt-5.5": "gpt-5.4-mini",
  "gpt-5.4": "gpt-5.4-mini",
  "gpt-5.4-mini": "gpt-5.4-nano",
  "gpt-4o": "gpt-4o-mini",
  "gpt-4.1": "gpt-4.1-mini",
  "o1": "o1-mini",
  "o1-preview": "o1-mini",
  // (no o3-mini → o4-mini: identically priced in MODEL_PRICE_PER_M, so it saves nothing)
  // Anthropic
  "claude-fable-5": "claude-sonnet-4-6",
  "claude-opus-4-8": "claude-sonnet-4-6",
  "claude-sonnet-4-6": "claude-haiku-4-5",
  // xAI
  "grok-4.3": "grok-build-0.1",
  // Gemini
  "gemini-3.1-pro-preview": "gemini-3.5-flash",
  "gemini-3.5-flash": "gemini-3.1-flash-lite",
  "gemini-2.5-pro": "gemini-2.5-flash",
  "gemini-2.5-flash": "gemini-2.5-flash-lite",
  // Mistral
  "mistral-large-2512": "mistral-medium-3-5",
  "mistral-medium-3-5": "mistral-small-2603",
  "mistral-large": "mistral-medium",
  "mistral-medium": "mistral-small",
  // DeepSeek
  "deepseek-reasoner": "deepseek-chat",
  "deepseek-v4-pro": "deepseek-v4-flash",
};

/** A cheaper model in the same family, or undefined if none is known. */
export function cheaperModel(model: string | null | undefined): string | undefined {
  if (!model) return undefined;
  const key = model.toLowerCase();
  if (CHEAPER_MODEL[key]) return CHEAPER_MODEL[key];
  // Prefix fallback for DATED/versioned suffixes only (e.g. "claude-opus-4-8-20251101" → the
  // "claude-opus-4-8" tier). Requires the remainder to be a "-<digit>..." date/version — never a
  // variant suffix like "-mini"/"-nano" (those must be exact keys, else they'd wrongly map to their
  // own base tier's downgrade, i.e. to themselves).
  const prefix = Object.keys(CHEAPER_MODEL).find((k) => {
    if (!key.startsWith(k)) return false;
    const rest = key.slice(k.length);
    return rest === "" || /^-\d/.test(rest);
  });
  return prefix ? CHEAPER_MODEL[prefix] : undefined;
}

export interface BudgetRunDecision {
  skip: boolean;
  downgraded: boolean;
  llmModel?: string;
  redTeamLlmModel?: string;
  reason?: string;
}

const NO_DECISION: BudgetRunDecision = { skip: false, downgraded: false };

/**
 * Decide whether to skip a strategy cycle or downgrade its models given current budget status.
 * Only active when USAGE_BUDGET_ENFORCE is on AND the monitor is configured. Returns a no-op
 * decision otherwise (and on any monitor failure — fail-open).
 *
 * Wired into `runStrategyOnce` at the per-user/day LLM budget choke point (see strategy.ts): the
 * caller applies this ONLY to the LLM proposal step (never the broker reconciliation or
 * risk-reducing exits above it), applies any model downgrade to the in-memory run policy only
 * (never the object `setPolicy` would persist), and — because `debateProposal` re-resolves its own
 * model from the policy it's handed — the downgraded `redTeamLlmModel` rides along on that same
 * in-memory policy so the Bear review picks it up too.
 */
export async function evaluateBudgetForRun(
  userId: string,
  policy: { llmModel?: string | null; redTeamLlmModel?: string | null },
  deps: { status?: BudgetStatus | null; fetchImpl?: typeof fetch } = {}
): Promise<BudgetRunDecision> {
  try {
    if (!usageBudgetEnforceEnabled() || !usageMonitorEnabled()) return NO_DECISION;
    const status = deps.status ?? (await getBudgetStatusCached({ fetchImpl: deps.fetchImpl }));
    if (!status) return NO_DECISION; // unknown → fail-open
    return computeBudgetDecision(policy, status);
  } catch {
    return NO_DECISION; // fail-open
  }
}

/**
 * Pure decision logic shared by `evaluateBudgetForRun` (gated on USAGE_BUDGET_ENFORCE) and
 * `previewBudgetDecision` (the advisory's ungated "what WOULD happen" preview — see
 * strategy.ts's `usage_budget_status` receipt). Never throws; callers wrap in try/catch anyway
 * for defense in depth. Kept separate from `evaluateBudgetForRun` so the advisory preview can see
 * what enforcement WOULD do without needing the flag on — the tested public contract of
 * `evaluateBudgetForRun` (flag-gated, fail-open) is unchanged.
 */
function computeBudgetDecision(
  policy: { llmModel?: string | null; redTeamLlmModel?: string | null },
  status: BudgetStatus
): BudgetRunDecision {
  // Resolve the models that will ACTUALLY serve this run, matching resolveLlmEndpoint: the green
  // model falls back to OPENAI_MODEL/the default when policy.llmModel is unset, and the red model
  // falls back to the green model. Enforcing on the raw (possibly undefined) policy fields would
  // silently no-op the common default-model case.
  const greenModel = resolveOpenAiModel(policy);
  const redModel = (policy.redTeamLlmModel && policy.redTeamLlmModel.trim()) || greenModel;

  const statusByProvider = new Map(status.providers.map((p) => [p.name.toLowerCase(), p.status]));
  const primaryProvider = providerForModel(greenModel);
  const primaryStatus = statusByProvider.get(primaryProvider) ?? "ok";

  if (primaryStatus !== "exceeded" && primaryStatus !== "warning") return NO_DECISION;

  const cheaperGreen = cheaperModel(greenModel);
  const greenChanged = !!cheaperGreen && cheaperGreen !== greenModel;

  // Skip the cycle only when the GREEN (primary) provider is fully over budget AND its model has no
  // cheaper tier — the green call is the dominant cost and can't be reduced. Red having a cheaper
  // tier does NOT rescue an over-budget green (that was the earlier bug: it kept running green).
  if (primaryStatus === "exceeded" && !greenChanged) {
    return {
      skip: true,
      downgraded: false,
      reason: `LLM provider "${primaryProvider}" over budget and "${greenModel}" is already the cheapest tier.`,
    };
  }

  const cheaperRed = cheaperModel(redModel);
  const redChanged = !!cheaperRed && cheaperRed !== redModel;
  if (greenChanged || redChanged) {
    return {
      skip: false,
      downgraded: true,
      llmModel: greenChanged ? cheaperGreen : undefined,
      redTeamLlmModel: redChanged ? cheaperRed : undefined,
      reason: `LLM provider "${primaryProvider}" is ${primaryStatus}; downgraded to a cheaper model tier.`,
    };
  }

  return NO_DECISION;
}

/**
 * ADVISORY preview of what `evaluateBudgetForRun` WOULD decide, ignoring the USAGE_BUDGET_ENFORCE
 * gate (only `usageMonitorEnabled()` still applies — no monitor configured means nothing to
 * preview). Used to populate the `usage_budget_status` audit receipt's `wouldSkip`/`wouldDowngrade`
 * fields every run, independent of whether enforcement is actually on, so the owner can see what
 * enforcement would have done before opting in. Fail-open (never throws).
 */
export async function previewBudgetDecision(
  userId: string,
  policy: { llmModel?: string | null; redTeamLlmModel?: string | null },
  deps: { status?: BudgetStatus | null; fetchImpl?: typeof fetch } = {}
): Promise<BudgetRunDecision> {
  try {
    if (!usageMonitorEnabled()) return NO_DECISION;
    const status = deps.status ?? (await getBudgetStatusCached({ fetchImpl: deps.fetchImpl }));
    if (!status) return NO_DECISION;
    return computeBudgetDecision(policy, status);
  } catch {
    return NO_DECISION;
  }
}

// ── Advisory formatting (Phase 2 wiring: strategy loop injects this into the prompt) ────────────

/**
 * Compact 1-2 line ADVISORY string summarizing operator LLM-provider spend vs budget, meant to be
 * injected into the Bull (and Bear) userContent next to `drawdownAdvisory` — DATA for the agent,
 * never a command. Returns undefined when there's nothing worth surfacing (monitor unconfigured,
 * or every provider is comfortably under budget) so callers can omit the field entirely.
 *
 * Only mentions providers at "warning" or "exceeded" — "ok"/"unconfigured" providers are silent
 * (matches checkBudgetAndAlert's alerting threshold, so the prompt and the notification pipe agree
 * on what counts as "worth mentioning").
 */
export function formatBudgetAdvisory(status: BudgetStatus | null | undefined): string | undefined {
  if (!status) return undefined;
  const notable = status.providers.filter((p) => p.status === "exceeded" || p.status === "warning");
  if (notable.length === 0) return undefined;

  const lines = notable.map((p) => {
    const pct = typeof p.percentUsed === "number" ? ` (${Math.round(p.percentUsed)}%)` : "";
    const budgetTxt = typeof p.monthlyBudgetUsd === "number" ? `$${p.monthlyBudgetUsd.toFixed(0)}` : "no set budget";
    return `${p.name}: $${p.spentUsd.toFixed(2)} spent of ${budgetTxt}${pct} this month, status=${p.status}`;
  });

  const anyExceeded = notable.some((p) => p.status === "exceeded");
  const suggestion = anyExceeded
    ? "At least one provider is over its monthly budget — worth weighing a cheaper model tier or skipping this cycle's LLM call, but it's your call."
    : "At least one provider is approaching its monthly budget — worth keeping an eye on model choice/frequency, but it's your call.";

  return `Operator LLM spend status: ${lines.join("; ")}. ${suggestion}`;
}

/** Audit + notify a budget-driven skip (called from the strategy loop). Never throws. */
export async function notifyBudgetSkip(
  userId: string,
  policy: TradingPolicy,
  runId: string,
  reason: string
): Promise<void> {
  try {
    audit("run_skipped_over_budget", { runId, userId, reason }, userId);
    await sendNotification(
      { type: "budget_alert", title: "Strategy run skipped — over budget", payload: { runId, reason } },
      { policy, userId }
    );
  } catch {
    /* best-effort */
  }
}
