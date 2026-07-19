/** Typed client for the console's mutations. Every function talks to the REAL
 *  existing endpoints — nothing here simulates. Errors are thrown as
 *  ConsoleApiError (human-readable message) so callers can surface them in a
 *  non-blocking notice. The live-approval typed-confirmation contract mirrors
 *  app/api/proposals/[id]/approve/route.ts exactly. */

import type { LlmReasoningEffort, PerformanceSummary, StrategyTuningProposal, SystemState, TradingPolicy } from "@/lib/types";

export class ConsoleApiError extends Error {
  status: number;
  payload?: unknown;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "ConsoleApiError";
    this.status = status;
    this.payload = payload;
  }
}

/** Thrown when the approve endpoint answers 409 LIVE_CONFIRMATION_REQUIRED.
 *  `expectedText` is the server-authoritative phrase (e.g. "APPROVE LIVE NVDA"). */
export class LiveConfirmationRequiredError extends Error {
  reasons: string[];
  expectedText: string;

  constructor(reasons: string[], expectedText: string) {
    super(reasons.join(" ") || "Typed confirmation required.");
    this.name = "LiveConfirmationRequiredError";
    this.reasons = reasons;
    this.expectedText = expectedText;
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json().catch(() => undefined);
  }
  return res.text().catch(() => undefined);
}

function messageFrom(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (typeof p.message === "string" && p.message) return p.message;
    if (typeof p.summary === "string" && p.summary) return p.summary;
    if (typeof p.error === "string" && p.error) return p.error;
  }
  return fallback;
}

/** True when a non-ok response's body is an HTML error page rather than this API's normal
 *  JSON/plain-text contract — e.g. Cloudflare's raw 524 "edge timeout" interstitial, or any other
 *  proxy/edge error page. Checked on BOTH the header and the body's own leading bytes: an edge
 *  proxy's error page can arrive with a missing or misleading content-type, so header-only
 *  detection isn't enough — this is what let a raw Cloudflare 524 page reach `messageFrom` before
 *  (a non-empty string payload was returned verbatim as the "message"). */
function looksLikeHtml(contentType: string, payload: unknown): boolean {
  if (contentType.includes("text/html")) return true;
  if (typeof payload !== "string") return false;
  const head = payload.trimStart().slice(0, 15).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html");
}

/** Clean, human message for a non-2xx response whose body is a raw HTML error page — this is
 *  NEVER rendered verbatim to the user. Cloudflare's edge timeout (524) is called out by name
 *  since a slow LLM-driven strategy run routinely triggers it in production (Coolify migration —
 *  the origin keeps running past the ~100s edge budget); other 5xx-range edge statuses and any
 *  other HTML error page get a generic "edge/proxy error" framing that still surfaces the code. */
function edgeErrorMessage(status: number): string {
  if (status === 524) {
    return "The server took too long to respond at the edge (524). The operation may still be running — check the Activity feed.";
  }
  if (status >= 520 && status <= 530) {
    return `The edge network returned an error (${status}) instead of reaching the app. The operation may still be running — check the Activity feed.`;
  }
  return `The server returned an unexpected error page (${status}) instead of a normal response. The operation may still be running — check the Activity feed.`;
}

/** Shared by every helper below so a raw HTML error page is never surfaced as an error message —
 *  applying this at the ONE shared response-error builder (rather than per-caller) means every
 *  dialog that goes through `request<T>` or `fetchDashboard` benefits automatically. */
function buildResponseError(res: Response, payload: unknown, fallback: string): ConsoleApiError {
  const contentType = res.headers.get("content-type") ?? "";
  if (looksLikeHtml(contentType, payload)) {
    return new ConsoleApiError(edgeErrorMessage(res.status), res.status, payload);
  }
  return new ConsoleApiError(messageFrom(payload, fallback), res.status, payload);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
    });
  } catch {
    throw new ConsoleApiError("Network error — the server could not be reached.", 0);
  }
  const payload = await parseBody(res);
  if (!res.ok) {
    throw buildResponseError(res, payload, `Request failed (${res.status}).`);
  }
  return payload as T;
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

const DASHBOARD_FETCH_TIMEOUT_MS = 30_000;

export async function fetchDashboard<T>(signal?: AbortSignal): Promise<T> {
  let res: Response;
  // Combine the caller's abort signal with a hard 30s timeout so a hung fetch
  // never leaves the console stuck in the loading state forever.  The timeout
  // is surfaced as a ConsoleApiError (408) rather than an AbortError so the
  // caller can distinguish "user navigated away" from "server not responding".
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), DASHBOARD_FETCH_TIMEOUT_MS);
  const onExternalAbort = () => {
    clearTimeout(timer);
    timeoutController.abort();
  };
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    res = await fetch("/api/dashboard", { cache: "no-store", signal: timeoutController.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      // If the *caller* requested the abort (navigation, unmount) rethrow it
      // so the caller can silently discard the result.  Otherwise it was our
      // timeout — surface it as a user-visible error.
      if (signal?.aborted) throw error;
      throw new ConsoleApiError("Dashboard data timed out — the server may be overloaded.", 408);
    }
    throw new ConsoleApiError("Network error — the server could not be reached.", 0);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
  if (!res.ok) {
    const payload = await parseBody(res);
    throw buildResponseError(res, payload, `Snapshot failed (${res.status}).`);
  }
  return (await res.json()) as T;
}

// ── Strategy run-state ───────────────────────────────────────────────────────

export interface RunOnceResult {
  runId: string;
  /** "started": the route launched the run and returned before it finished (real runs can take
   *  several minutes on LLM-heavy steps) — the run keeps executing server-side; track it via the
   *  existing Activity/snapshot polling, not this response. */
  status: "completed" | "failed" | "started";
  summary: string;
}

/** Manual run — the server forces manual runs to propose-only authority. Async: the route races
 *  the run against a bounded window and may return `status: "started"` (202) instead of waiting
 *  for the whole run to finish — see app/api/strategy/run/route.ts. */
export function runOnce(): Promise<RunOnceResult> {
  return request<RunOnceResult>("/api/strategy/run", { method: "POST", body: JSON.stringify({ manual: true }) });
}

/** STOP everything: systemState → halted. Never sells anything. */
export function stopEverything(): Promise<TradingPolicy> {
  return request<TradingPolicy>("/api/strategy/pause", { method: "POST" });
}

/** Start scheduled runs: systemState → active (server verifies account + universe + agenticAllowed). */
export function startStrategy(): Promise<TradingPolicy> {
  return request<TradingPolicy>("/api/strategy/enable", { method: "POST" });
}

/** Set close_only / liquidating via the policy endpoint (halted goes through stopEverything,
 *  active through startStrategy so the server's arming preconditions run). */
export function setSystemState(state: Exclude<SystemState, "active" | "halted">): Promise<TradingPolicy> {
  return request<TradingPolicy>("/api/policy", { method: "PUT", body: JSON.stringify({ systemState: state }) });
}

// ── Policy / prompt ──────────────────────────────────────────────────────────

export type PolicyPatchBody = Record<string, unknown> & { strategyPrompt?: string };

export function savePolicy(patch: PolicyPatchBody): Promise<TradingPolicy> {
  return request<TradingPolicy>("/api/policy", { method: "PUT", body: JSON.stringify(patch) });
}

/** AI strategy review (#12): POST the existing tune endpoint. The server builds
 *  the evidence pack (performance, missed opportunities, factor scorecard,
 *  macro) and returns a reviewed proposal; nothing is applied until the user
 *  commits it through savePolicy. `tuningConfigWarnings` piggybacks on the
 *  manual path as cautions (never blocks). */
export interface StrategyTuneResult extends StrategyTuningProposal {
  tuningConfigWarnings?: Array<{ message: string }>;
}

export function tuneStrategy(model?: string, reasoningEffort?: LlmReasoningEffort): Promise<StrategyTuneResult> {
  return request<StrategyTuneResult>("/api/strategy/tune", {
    method: "POST",
    body: JSON.stringify({ ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) })
  });
}

// ── Proposals ────────────────────────────────────────────────────────────────

export interface LiveApprovalConfirmationBody {
  proposalId: string;
  accountNumber?: string | null;
  executionMode: "broker/live";
  estimatedNotional?: number | null;
  typedText: string;
}

export interface ApproveResult {
  status: string;
  orderId?: string;
  brokerState?: string;
  fillStatus?: string;
  reasons?: string[];
}

export async function approveProposal(
  id: string,
  liveConfirmation?: LiveApprovalConfirmationBody
): Promise<ApproveResult> {
  try {
    return await request<ApproveResult>(`/api/proposals/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify(liveConfirmation ? { liveConfirmation } : {})
    });
  } catch (error) {
    if (error instanceof ConsoleApiError && error.status === 409 && error.payload && typeof error.payload === "object") {
      const p = error.payload as { error?: string; reasons?: string[]; expectedText?: string; message?: string };
      if (p.error === "LIVE_CONFIRMATION_REQUIRED" && typeof p.expectedText === "string") {
        throw new LiveConfirmationRequiredError(Array.isArray(p.reasons) ? p.reasons : [], p.expectedText);
      }
    }
    throw error;
  }
}

export interface BulkApproveResult extends ApproveResult {
  proposalId: string;
  symbol?: string;
}

export async function bulkApproveProposals(
  proposalIds: string[],
  liveConfirmation?: { typedText: string }
): Promise<{ results: BulkApproveResult[] }> {
  try {
    return await request<{ results: BulkApproveResult[] }>("/api/proposals/bulk-approve", {
      method: "POST",
      body: JSON.stringify({ proposalIds, ...(liveConfirmation ? { liveConfirmation } : {}) })
    });
  } catch (error) {
    if (error instanceof ConsoleApiError && error.status === 409 && error.payload && typeof error.payload === "object") {
      const p = error.payload as { error?: string; reasons?: string[]; expectedText?: string; message?: string };
      if (p.error === "LIVE_CONFIRMATION_REQUIRED" && typeof p.expectedText === "string") {
        throw new LiveConfirmationRequiredError(Array.isArray(p.reasons) ? p.reasons : [], p.expectedText);
      }
    }
    throw error;
  }
}

export function rejectProposal(id: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/api/proposals/${encodeURIComponent(id)}/reject`, { method: "POST" });
}

// ── Accounts / profiles / settings ───────────────────────────────────────────

export function activateAccount(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/connected-accounts/${encodeURIComponent(id)}/activate`, { method: "POST" });
}

export interface AccountPerformanceResult {
  account: { id: string; label: string; broker: string; environment: "paper" | "live" };
  performance: PerformanceSummary | null;
  /** True when `performance`'s unrealized-P&L fields were computed with no live quotes
   *  (this endpoint never fetches them) -- render unrealized as unavailable ("-"), not
   *  as the real $0.00 it would be for an account with genuinely no open positions. */
  pricesUnavailable: boolean;
}

/** Results-page comparison picker: performance for ONE OTHER connected account, by id.
 *  The server resolves accountNumber itself (scoped to the requesting user) — this never
 *  sends an accountNumber from the client. */
export function fetchAccountPerformance(id: string): Promise<AccountPerformanceResult> {
  return request<AccountPerformanceResult>(`/api/connected-accounts/${encodeURIComponent(id)}/performance`);
}

/** Library-activate a preset (flips the library's active flag and writes the
 *  user-level base policy — including the preset's stored systemState). Only
 *  used as the fallback when NO connected account exists; prefer
 *  copyProfileToAccount, which preserves the account's run-state. */
export function activateProfile(id: string): Promise<unknown> {
  return request<unknown>(`/api/profiles/${encodeURIComponent(id)}/activate`, { method: "POST" });
}

/** Copy a saved preset onto a CHOSEN connected account's live strategy state
 *  (POST /api/profiles/[id]/copy → applyProfileToAccount). The target
 *  account's current run-state (systemState) is preserved server-side — a
 *  preset can never arm or disarm anything — and the library active flag is
 *  left untouched. */
export function copyProfileToAccount(
  profileId: string,
  connectedAccountId: string
): Promise<{ profileId: string; connectedAccountId: string }> {
  return request<{ profileId: string; connectedAccountId: string }>(
    `/api/profiles/${encodeURIComponent(profileId)}/copy`,
    { method: "POST", body: JSON.stringify({ connectedAccountId }) }
  );
}

export function setAutoResume(enabled: boolean): Promise<{ autoResumeOnBoot: boolean }> {
  return request<{ autoResumeOnBoot: boolean }>("/api/settings/auto-resume", {
    method: "POST",
    body: JSON.stringify({ enabled })
  });
}

export interface NotifyTestResult {
  results: Array<{ channel: string; ok: boolean; skipped?: string; error?: string }>;
}

export function sendTestNotification(): Promise<NotifyTestResult> {
  return request<NotifyTestResult>("/api/notifications/test", { method: "POST", body: JSON.stringify({}) });
}

// ── Alert lifecycle (acknowledge) ───────────────────────────────────────────

export interface AcknowledgeNotificationsResult {
  acknowledged: number;
}

/** Acknowledge specific Alert Center rows by id. */
export function acknowledgeNotifications(ids: string[]): Promise<AcknowledgeNotificationsResult> {
  return request<AcknowledgeNotificationsResult>("/api/notifications/ack", {
    method: "POST",
    body: JSON.stringify({ ids })
  });
}

/** Bulk-acknowledge every currently-unacknowledged row matching the Attention filter. Pass the
 *  active connected account id so the ack is scoped to what the Alert Center is actually showing
 *  (that account + account-less rows) — otherwise a hidden other-account alert the user never saw
 *  would get silently acknowledged too. */
export function acknowledgeAllAttention(connectedAccountId?: string): Promise<AcknowledgeNotificationsResult> {
  return request<AcknowledgeNotificationsResult>("/api/notifications/ack", {
    method: "POST",
    body: JSON.stringify({ all: true, filter: "attention", ...(connectedAccountId ? { connectedAccountId } : {}) })
  });
}
