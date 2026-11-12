import { NextResponse } from "next/server";
import { isAbortOrTimeoutError, isTransientNetworkError } from "./network-errors";
import { safeErrorMessage } from "./telemetry-sanitize";

export const API_ERROR_MESSAGE_MAX = 240;

export type ApiErrorBody = {
  ok: false;
  error: string;
  message: string;
};

function boundMessage(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length <= API_ERROR_MESSAGE_MAX) return trimmed;
  return `${trimmed.slice(0, API_ERROR_MESSAGE_MAX - 1)}…`;
}

export function jsonError(status: number, code: string, message: string): NextResponse<ApiErrorBody> {
  return NextResponse.json({ ok: false, error: code, message: boundMessage(message) }, { status });
}

function httpStatusFromError(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== "number" || !Number.isFinite(status)) return undefined;
  return status;
}

function extractHttpStatusFromMessage(message: string): number | undefined {
  const match =
    message.match(/HTTP\s+(\d{3})\b/i) ??
    // Public.com adapters throw "Public cancel 500" / "Public accounts 401" (no "HTTP" prefix).
    message.match(/\bPublic(?:\.com)?(?:\s+\w+){1,3}\s+(\d{3})\b/) ??
    message.match(/\bfailed\s+\((\d{3})\)/i);
  if (!match) return undefined;
  const code = Number(match[1]);
  return Number.isFinite(code) ? code : undefined;
}

function isBrokerDeadlineMessage(message: string): boolean {
  return /timed out waiting for/i.test(message);
}

/**
 * Adapter-originated broker failures that do not carry a numeric status or "HTTP NNN" text.
 * Kept narrow so a post-cancel database or notification fault is not classified as a broker outage.
 */
const BROKER_ADAPTER_MESSAGE =
  /robinhood not connected|robinhood session expired|robinhood mcp (?:tool reported an error|sse response)|alpaca mcp\b|no public\.com account connected|public\.com secret is missing|public token mint|no tradier account connected/i;

/**
 * Maps an uncaught broker-gateway read failure to a JSON envelope clients can parse.
 * Never forwards raw upstream bodies or credential material (uses status codes only).
 */
export function brokerReadError(error: unknown): NextResponse<ApiErrorBody> {
  const message = safeErrorMessage(error);
  if (isAbortOrTimeoutError(error) || isBrokerDeadlineMessage(message)) {
    return jsonError(504, "broker_timeout", "The broker did not respond in time.");
  }

  const httpStatus = httpStatusFromError(error) ?? extractHttpStatusFromMessage(message);

  if (httpStatus === 401 || httpStatus === 403 || /robinhood session expired/i.test(message)) {
    return jsonError(502, "broker_auth_failed", "Broker credentials were rejected.");
  }

  if (
    /no connected broker account/i.test(message) ||
    /robinhood not connected/i.test(message) ||
    /no public\.com account connected/i.test(message) ||
    /no tradier account connected/i.test(message)
  ) {
    return jsonError(502, "broker_unavailable", "No connected broker account.");
  }

  if (httpStatus !== undefined && httpStatus >= 500) {
    return jsonError(502, "broker_unavailable", `Broker returned HTTP ${httpStatus}.`);
  }

  if (httpStatus !== undefined && httpStatus >= 400) {
    return jsonError(502, "broker_unavailable", `Broker request failed (HTTP ${httpStatus}).`);
  }

  return jsonError(502, "broker_unavailable", "Broker is temporarily unavailable.");
}

/**
 * True when an error plausibly came from the broker call itself (timeout, transport failure,
 * HTTP status, or a missing broker account).  Routes that run local bookkeeping after a broker
 * call use this so a database or notification fault is not misreported as a broker outage.
 */
export function isBrokerGatewayError(error: unknown): boolean {
  if (isAbortOrTimeoutError(error) || isTransientNetworkError(error)) return true;
  const message = safeErrorMessage(error);
  if ((httpStatusFromError(error) ?? extractHttpStatusFromMessage(message)) !== undefined) return true;
  if (isBrokerDeadlineMessage(message)) return true;
  if (/no connected broker account/i.test(message)) return true;
  return BROKER_ADAPTER_MESSAGE.test(message);
}

/** Map broker-originated failures to the JSON envelope; rethrow adapter/server defects as 500. */
export function brokerReadOrRethrow(error: unknown): NextResponse<ApiErrorBody> {
  if (isBrokerGatewayError(error)) return brokerReadError(error);
  throw error;
}

/**
 * Read a JSON request body without throwing.  Malformed JSON is 400 `invalid_json`.  A body that
 * cannot be read at all (client aborted the stream, body already consumed) is 400
 * `unreadable_body`, so callers that parse before their own `try` (POST /api/keys,
 * POST /api/orders/cancel) still answer with the JSON envelope instead of an unhandled 500.
 */
export async function parseRequestJson(
  request: Request
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse<ApiErrorBody> }> {
  try {
    const body = await request.json();
    return { ok: true, body };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, response: jsonError(400, "invalid_json", "Request body must be valid JSON.") };
    }
    return { ok: false, response: jsonError(400, "unreadable_body", "Request body could not be read.") };
  }
}
