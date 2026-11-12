import { AUTHENTICATED_EMAIL_HEADER, resolveRequestUserFromEmail } from "./request-user";
import { enforceRateLimit, RATE_LIMITS, type RateLimitOptions } from "./rate-limit";

export type AdminIngestLimitKind = "job" | "read";

function optionsFor(kind: AdminIngestLimitKind): RateLimitOptions {
  switch (kind) {
    case "job":
      return RATE_LIMITS.adminIngest;
    case "read":
      return RATE_LIMITS.adminIngestRead;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/**
 * Subject for an already-authorized admin ingest call.
 * Uses the middleware email when one is present. Token-only callers have no email and share the
 * stable local identity. This does not call resolveRequestUser, so a token-only caller is not
 * failed by the live-bootstrap identity check.
 */
export function adminIngestSubject(request: Request): string {
  return resolveRequestUserFromEmail(request.headers.get(AUTHENTICATED_EMAIL_HEADER)).userId;
}

/** Full sliding-window key. Tests saturate this exact bucket. */
export function adminIngestBucketKey(request: Request, route: string, kind: AdminIngestLimitKind): string {
  return `${adminIngestSubject(request)}:admin-ingest:${kind}:${route}`;
}

/**
 * Returns a 429 Response when this admin is over the ingest budget, or null to proceed.
 * Call it only after requireAdmin has allowed the request.
 */
export function enforceAdminIngestRateLimit(
  request: Request,
  route: string,
  kind: AdminIngestLimitKind
): Response | null {
  return enforceRateLimit(adminIngestSubject(request), `admin-ingest:${kind}:${route}`, optionsFor(kind));
}
