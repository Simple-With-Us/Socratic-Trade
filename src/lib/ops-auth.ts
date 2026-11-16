import { timingSafeEqual } from "crypto";

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Accepted env secret for `/api/ops/*` and the operator projection on `/api/health`.
 * `OPS_DIAGNOSTIC_TOKEN` is required.  `ADMIN_REINDEX_TOKEN` is a different admin
 * gate and is never an ops fallback — even in non-production, even when the two
 * values happen to match.  Do not mint a second token if both envs already share
 * one value; just keep using `OPS_DIAGNOSTIC_TOKEN`.
 */
export function opsDiagnosticSecrets(): string[] {
  const ops = process.env.OPS_DIAGNOSTIC_TOKEN?.trim();
  return ops ? [ops] : [];
}

/** True when this process has a usable ops diagnostic token.  Production must. */
export function opsDiagnosticTokenConfigured(): boolean {
  return opsDiagnosticSecrets().length > 0;
}

/**
 * Gate for `/api/ops/*` — token-only, no session. Accepts `x-ops-token`, legacy
 * `x-admin-token`, or `Authorization: Bearer <token>`. Uses constant-time compare.
 */
export function authorizeOpsRequest(request: Request): boolean {
  const secrets = opsDiagnosticSecrets();
  if (secrets.length === 0) return false;
  const provided =
    request.headers.get("x-ops-token")?.trim() ||
    request.headers.get("x-admin-token")?.trim() ||
    readBearerToken(request);
  if (!provided) return false;
  return secrets.some((secret) => tokensMatch(provided, secret));
}
