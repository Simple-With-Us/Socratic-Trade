/** Typed client for the console's mutations. Every function talks to the REAL
 *  existing endpoints — nothing here simulates. Errors are thrown as
 *  ConsoleApiError (human-readable message) so callers can surface them in a
 *  non-blocking notice. The live-approval typed-confirmation contract mirrors
 *  app/api/proposals/[id]/approve/route.ts exactly. */

import type { LlmReasoningEffort, StrategyTuningProposal, SystemState, TradingPolicy } from "@/lib/types";

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
    throw new ConsoleApiError(messageFrom(payload, `Request failed (${res.status}).`), res.status, payload);
  }
  return payload as T;
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

export async function fetchDashboard<T>(signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch("/api/dashboard", { cache: "no-store", signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ConsoleApiError("Network error — the server could not be reached.", 0);
  }
  if (!res.ok) {
    const payload = await parseBody(res);
    throw new ConsoleApiError(messageFrom(payload, `Snapshot failed (${res.status}).`), res.status, payload);
  }
  return (await res.json()) as T;
}

// ── Strategy run-state ───────────────────────────────────────────────────────

export interface RunOnceResult {
  runId: string;
  status: "completed" | "failed";
  summary: string;
}

/** Manual run — the server forces manual runs to propose-only authority. */
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

export function rejectProposal(id: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/api/proposals/${encodeURIComponent(id)}/reject`, { method: "POST" });
}

// ── Accounts / profiles / settings ───────────────────────────────────────────

export function activateAccount(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/connected-accounts/${encodeURIComponent(id)}/activate`, { method: "POST" });
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
