import { NextResponse } from "next/server";
import { isAbortOrTimeoutError } from "./network-errors";
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
  const match = message.match(/HTTP\s+(\d{3})\b/i);
  if (!match) return undefined;
  const code = Number(match[1]);
  return Number.isFinite(code) ? code : undefined;
}

/**
 * Maps an uncaught broker-gateway read failure to a JSON envelope clients can parse.
 * Never forwards raw upstream bodies or credential material (uses status codes only).
 */
export function brokerReadError(error: unknown): NextResponse<ApiErrorBody> {
  if (isAbortOrTimeoutError(error)) {
    return jsonError(504, "broker_timeout", "The broker did not respond in time.");
  }

  const message = safeErrorMessage(error);
  const httpStatus = httpStatusFromError(error) ?? extractHttpStatusFromMessage(message);

  if (httpStatus === 401 || httpStatus === 403) {
    return jsonError(502, "broker_auth_failed", "Broker credentials were rejected.");
  }

  if (/no connected broker account/i.test(message)) {
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
    return { ok: false, response: jsonError(400, "invalid_json", "Request body must be valid JSON.") };
  }
}
