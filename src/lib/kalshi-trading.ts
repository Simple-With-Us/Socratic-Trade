/**
 * Kalshi event-contract trading — SEPARATE from equity BrokerGateway.
 *
 * Live Kalshi money is a kill switch that defaults OFF.  Paper/dry-run is
 * the only path unless BOTH `KALSHI_LIVE_ORDERS` (env) and
 * `policy.kalshiLiveOrdersEnabled` are on.  Demo credentials never hit prod
 * because the base URL is derived from KALSHI_ENV.
 */

import { audit } from "./db";
import {
  getKalshiConfig,
  kalshiApiBase,
  kalshiAuthHeaders,
  type KalshiConfig
} from "./kalshi";

export type KalshiContractSide = "yes" | "no";
export type KalshiOrderAction = "buy" | "sell";

export interface KalshiEventOrderInput {
  ticker: string;
  side: KalshiContractSide;
  action: KalshiOrderAction;
  count: number;
  type?: "limit" | "market";
  /** Integer cents 1-99 for the chosen side. Required for limit. */
  priceCents?: number;
  clientOrderId?: string;
}

export interface KalshiOrderPolicy {
  eventContractsEnabled?: boolean;
  kalshiLiveOrdersEnabled?: boolean;
}

export interface KalshiOrderResult {
  status: "dry_run" | "paper" | "live" | "blocked";
  reason?: string;
  orderId?: string;
  clientOrderId?: string;
  submitted?: Record<string, unknown>;
  raw?: unknown;
}

const REQUEST_TIMEOUT_MS = 10_000;

type EnvMap = Record<string, string | undefined>;
function asProcessEnv(env: EnvMap): NodeJS.ProcessEnv {
  return env as NodeJS.ProcessEnv;
}

export function kalshiLiveOrdersEnvEnabled(env: EnvMap = process.env): boolean {
  const raw = env.KALSHI_LIVE_ORDERS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export function evaluateKalshiOrderPolicy(
  policy: KalshiOrderPolicy,
  env: EnvMap = process.env
): { allowed: true; live: false } | { allowed: true; live: true } | { allowed: false; reason: string } {
  if (policy.eventContractsEnabled !== true) {
    return { allowed: false, reason: "Event-contract trading is off. Enable Event Contracts in Guardrails for paper/dry-run." };
  }
  const config = getKalshiConfig(asProcessEnv(env));
  if (!config) {
    return { allowed: false, reason: "Kalshi is unconfigured (set KALSHI_ENV=demo or prod)." };
  }
  if (!config.keyId || !config.privateKeyPem) {
    return { allowed: false, reason: "Kalshi trading needs KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PEM. Market-data-only config cannot place orders." };
  }
  const live = kalshiLiveOrdersEnvEnabled(env) && policy.kalshiLiveOrdersEnabled === true;
  return { allowed: true, live };
}

export function assertKalshiOrderInput(input: KalshiEventOrderInput): string | undefined {
  if (!input.ticker.trim()) return "ticker is required.";
  if (!Number.isInteger(input.count) || input.count <= 0) return "count must be a positive integer contract count.";
  if ((input.type ?? "limit") === "limit") {
    const px = input.priceCents;
    if (!(typeof px === "number" && Number.isInteger(px) && px > 0 && px < 100)) {
      return "limit orders require priceCents as an integer in 1-99.";
    }
  }
  return undefined;
}

function kalshiBodyFor(input: KalshiEventOrderInput): Record<string, unknown> {
  const type = input.type ?? "limit";
  const body: Record<string, unknown> = {
    ticker: input.ticker.trim().toUpperCase(),
    side: input.side,
    action: input.action,
    count: input.count,
    type
  };
  if (input.clientOrderId) body.client_order_id = input.clientOrderId;
  if (type === "limit" && input.priceCents != null) {
    if (input.side === "yes") body.yes_price = input.priceCents;
    else body.no_price = input.priceCents;
  }
  return body;
}

export async function kalshiSignedRequest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  options: { body?: unknown; config?: KalshiConfig; fetchImpl?: typeof fetch } = {}
): Promise<{ ok: boolean; status: number; body: unknown } | null> {
  const config = options.config ?? getKalshiConfig();
  if (!config) return null;
  const url = `${config.baseUrl}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...kalshiAuthHeaders(config, method, new URL(url).pathname)
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const fetchImpl = options.fetchImpl ?? fetch;
    const res = await fetchImpl(url, {
      method,
      cache: "no-store",
      signal: controller.signal,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function placeKalshiEventOrder(input: {
  order: KalshiEventOrderInput;
  policy: KalshiOrderPolicy;
  userId?: string;
  connectedAccountId?: string;
  env?: EnvMap;
  fetchImpl?: typeof fetch;
}): Promise<KalshiOrderResult> {
  const bad = assertKalshiOrderInput(input.order);
  if (bad) return { status: "blocked", reason: bad };
  const decision = evaluateKalshiOrderPolicy(input.policy, input.env ?? process.env);
  if (!decision.allowed) return { status: "blocked", reason: decision.reason };
  const submitted = kalshiBodyFor(input.order);
  const clientOrderId = input.order.clientOrderId ?? `kalshi-${Date.now()}`;
  submitted.client_order_id = clientOrderId;

  if (!decision.live) {
    audit(
      "kalshi_order_dry_run",
      { ticker: input.order.ticker, side: input.order.side, action: input.order.action, count: input.order.count, clientOrderId },
      input.userId,
      input.connectedAccountId
    );
    return { status: "dry_run", clientOrderId, submitted, reason: "Live Kalshi orders are off. This was a dry-run receipt only." };
  }

  const res = await kalshiSignedRequest("POST", "/portfolio/orders", {
    body: submitted,
    config: getKalshiConfig(input.env ? asProcessEnv(input.env) : undefined),
    fetchImpl: input.fetchImpl
  });
  if (!res) return { status: "blocked", reason: "Kalshi order request failed (network or unconfigured)." };
  if (!res.ok) {
    return { status: "blocked", reason: `Kalshi rejected the order (HTTP ${res.status}).`, raw: res.body, submitted };
  }
  const body = res.body && typeof res.body === "object" ? (res.body as Record<string, unknown>) : {};
  const order = (body.order && typeof body.order === "object" ? body.order : body) as Record<string, unknown>;
  const orderId = typeof order.order_id === "string" ? order.order_id : typeof order.id === "string" ? order.id : undefined;
  audit(
    "kalshi_order_placed",
    { ticker: input.order.ticker, orderId, clientOrderId, env: getKalshiConfig(input.env ? asProcessEnv(input.env) : undefined)?.env },
    input.userId,
    input.connectedAccountId
  );
  return { status: "live", orderId, clientOrderId, submitted, raw: res.body };
}

export async function cancelKalshiEventOrder(input: {
  orderId: string;
  policy: KalshiOrderPolicy;
  userId?: string;
  connectedAccountId?: string;
  env?: EnvMap;
  fetchImpl?: typeof fetch;
}): Promise<KalshiOrderResult> {
  const decision = evaluateKalshiOrderPolicy(input.policy, input.env ?? process.env);
  if (!decision.allowed) return { status: "blocked", reason: decision.reason };
  if (!decision.live) {
    audit("kalshi_order_cancel_dry_run", { orderId: input.orderId }, input.userId, input.connectedAccountId);
    return { status: "dry_run", orderId: input.orderId, reason: "Live Kalshi orders are off. Cancel was a dry-run." };
  }
  const res = await kalshiSignedRequest("DELETE", `/portfolio/orders/${encodeURIComponent(input.orderId)}`, {
    config: getKalshiConfig(input.env ? asProcessEnv(input.env) : undefined),
    fetchImpl: input.fetchImpl
  });
  if (!res) return { status: "blocked", reason: "Kalshi cancel request failed (network or unconfigured)." };
  if (!res.ok) return { status: "blocked", reason: `Kalshi rejected the cancel (HTTP ${res.status}).`, raw: res.body };
  audit("kalshi_order_cancelled", { orderId: input.orderId }, input.userId, input.connectedAccountId);
  return { status: "live", orderId: input.orderId, raw: res.body };
}

export { kalshiApiBase };
