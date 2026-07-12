/** Typed fetch helpers for the Settings sub-sections (brokers, API keys,
 *  models, delivery channels). Self-contained on purpose — the shared console
 *  client (app/console/lib/api.ts) stays untouched; only its ConsoleApiError
 *  is reused so every settings error surfaces through the same toast pattern.
 *  Every function talks to REAL existing endpoints — nothing here simulates. */

import { ConsoleApiError } from "../lib/api";

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

// ── Broker connections ───────────────────────────────────────────────────────

/** Where the browser must go to start Robinhood OAuth (full-page redirect —
 *  the flow returns to the legacy dashboard, which finishes the account sync). */
export const ROBINHOOD_OAUTH_START_URL = "/api/auth/robinhood/start";

export interface RobinhoodMcpHealth {
  ok: boolean;
  configured: boolean;
  authenticated: boolean;
  tools: string[];
  checkedAt: string;
  error?: string;
}

/** GET /api/broker/mcp/health — is the Robinhood MCP OAuth session usable? */
export function fetchRobinhoodHealth(): Promise<RobinhoodMcpHealth> {
  return request<RobinhoodMcpHealth>("/api/broker/mcp/health");
}

/** POST /api/connected-accounts {broker:"robinhood"} — after OAuth, pull the
 *  real agentic account from the live MCP into connected accounts. Idempotent
 *  server-side (re-sync reuses the existing row). */
export function syncRobinhoodAccount(): Promise<{ ok: boolean; accountNumber?: string; label?: string }> {
  return request<{ ok: boolean; accountNumber?: string; label?: string }>("/api/connected-accounts", {
    method: "POST",
    body: JSON.stringify({ broker: "robinhood" })
  });
}

export interface AlpacaConnectBody {
  label?: string;
  accountNumber: string;
  apiKey: string;
  apiSecret?: string;
  taxationType?: "taxable" | "roth_ira" | "traditional_ira";
}

/** POST /api/connected-accounts {broker:"alpaca", ...}. The server infers
 *  paper vs live from the credentials ("PA…" account / "PK…" key = paper) and
 *  fills the default endpoint — no base URL needed here. */
export function connectAlpacaAccount(body: AlpacaConnectBody): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/connected-accounts", {
    method: "POST",
    body: JSON.stringify({ broker: "alpaca", ...body })
  });
}

/** POST /api/connected-accounts {broker:"test"} — creates the explicit local
 *  mock paper account. The server keeps it inactive until the user switches to it. */
export function connectTestAccount(): Promise<{ ok: boolean; accountNumber?: string; label?: string }> {
  return request<{ ok: boolean; accountNumber?: string; label?: string }>("/api/connected-accounts", {
    method: "POST",
    body: JSON.stringify({ broker: "test" })
  });
}

/** DELETE /api/connected-accounts/[id] — removes the connection (and its
 *  stored credentials) from this app. Nothing at the broker is touched. */
export function disconnectAccount(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/connected-accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ── API keys ─────────────────────────────────────────────────────────────────

/** One catalog entry from GET /api/keys. The key VALUE is never returned by
 *  the server — only whether one resolves and where it came from. */
export interface ApiKeyEntry {
  service: string;
  label: string;
  category: string;
  unlocks: string;
  docsUrl: string;
  envVar?: string;
  /** True when a key resolves for this user (own key or server env). */
  configured: boolean;
  /** "user" = your stored key, "env" = the server operator's env var, "none". */
  source: "user" | "env" | "none";
  /** Set only when YOU have a stored key. */
  updatedAt?: string;
  savedLabel?: string;
}

export function listApiKeys(): Promise<{ keys: ApiKeyEntry[] }> {
  return request<{ keys: ApiKeyEntry[] }>("/api/keys");
}

/** POST /api/keys — add or replace your key for a service. The value is sent
 *  once and stored server-side; it is never echoed back. */
export function saveApiKey(service: string, apiKey: string, label?: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>("/api/keys", {
    method: "POST",
    body: JSON.stringify({ service, apiKey, ...(label?.trim() ? { label: label.trim() } : {}) })
  });
}

export function deleteApiKey(service: string): Promise<{ success: boolean; deleted: boolean }> {
  return request<{ success: boolean; deleted: boolean }>(`/api/keys?service=${encodeURIComponent(service)}`, {
    method: "DELETE"
  });
}

// ── LLM provider availability ────────────────────────────────────────────────

/** GET /api/chat/providers — per-provider "a key resolves for this user"
 *  booleans (never the keys). Same check the server makes before a real call. */
export function fetchChatProviders(): Promise<{ providers: Record<string, boolean> }> {
  return request<{ providers: Record<string, boolean> }>("/api/chat/providers");
}

// ── Delivery channels (out-of-app alert delivery) ────────────────────────────

export interface DeliveryChannelDescriptor {
  id: "push" | "webhook" | "email" | "sms";
  label: string;
  /** False when the server operator hasn't configured the channel's provider. */
  available: boolean;
  provider?: string | null;
  targetField: string;
  targetLabel: string;
  placeholder: string;
  hint: string;
}

export interface DeliveryPrefs {
  channels: string[];
  pushTarget: string;
  webhookUrl: string;
  email: string;
  phone: string;
}

export const EMPTY_DELIVERY_PREFS: DeliveryPrefs = {
  channels: [],
  pushTarget: "",
  webhookUrl: "",
  email: "",
  phone: ""
};

export function fetchDeliverySettings(): Promise<{ channels: DeliveryChannelDescriptor[]; prefs: DeliveryPrefs }> {
  return request<{ channels: DeliveryChannelDescriptor[]; prefs: DeliveryPrefs }>("/api/notifications");
}

export function saveDeliveryPrefs(prefs: DeliveryPrefs): Promise<{ prefs: DeliveryPrefs }> {
  return request<{ prefs: DeliveryPrefs }>("/api/notifications", {
    method: "POST",
    body: JSON.stringify(prefs)
  });
}
