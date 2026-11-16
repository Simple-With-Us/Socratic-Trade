import {
  buildOperationInFlightRejection,
  buildRateLimitedRejection,
  getOperationGuardHttpStatus
} from "@jaywedgeworth22/congress-trading-shared";
import type { OperationLeaseBusy } from "./operation-lease";

function jsonResponse(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: false, ...body }), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

export function rateLimitedOperationResponse(
  operation: string,
  retryAfterSeconds: number,
  error: string = `Rate limit exceeded for operation "${operation}". Please retry shortly.`
): Response {
  const retry = Number.isFinite(retryAfterSeconds) ? Math.max(1, Math.ceil(retryAfterSeconds)) : 1;
  const rejection = buildRateLimitedRejection(operation, retry);
  return jsonResponse(
    getOperationGuardHttpStatus(rejection),
    { ...rejection, error },
    { "retry-after": String(retry) }
  );
}

export function operationInFlightResponse(
  operation: string,
  activeOperation: string,
  error: string = `Operation "${operation}" conflicts with "${activeOperation}", which is already running.`,
  extra: Record<string, unknown> = {}
): Response {
  const rejection = buildOperationInFlightRejection(operation, activeOperation);
  return jsonResponse(getOperationGuardHttpStatus(rejection), {
    ...rejection,
    error,
    ...extra
  });
}

/** Map a typed core-boundary busy result through the shared v1.5 rejection contract. */
export function operationLeaseBusyResponse(operation: string, busy: OperationLeaseBusy): Response {
  return operationInFlightResponse(
    operation,
    busy.activeOperation,
    `Operation "${operation}" conflicts with "${busy.activeOperation}", which is already running.`,
    { operationGroup: busy.group, retryAfterSeconds: busy.retryAfterSeconds }
  );
}
