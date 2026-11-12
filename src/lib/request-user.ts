// Resolve the authenticated app userId for a request.
//
// SECURITY: identity metadata is established by `middleware.ts`, which strips client-supplied hints
// and forwards either a verified upstream email or the explicit auth-unconfigured local fallback.
// We map that middleware-supplied email → a stable userId here. We NEVER trust a client-supplied
// `x-user-id`, `?userId`, or body `userId` — those were the old IDOR vectors. Security-sensitive role
// checks must additionally inspect middleware's identity-source provenance; see `auth/admin.ts`.

import { DEV_USER_ID, userIdForEmail } from "./auth/identity";
import { isAuthServerSessionActive } from "./db-auth-sessions";
import { isLiveBootstrap } from "./auth-secret-guard";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES,
  AUTHENTICATED_SESSION_ISSUED_AT_HEADER,
  AUTHENTICATED_SESSION_SID_HEADER,
} from "./auth/strip-identity";
import { resolveAuthenticatedAccountGeneration } from "./user-write-fence";

/** Header set by middleware after resolving identity. Client-supplied copies are stripped first. */
export const AUTHENTICATED_EMAIL_HEADER = "x-authenticated-user-email";

/** Back-compat: the dev/test fallback identity. */
export const DEFAULT_REQUEST_USER_ID = DEV_USER_ID;

export interface ResolvedRequestUser {
  userId: string;
  email?: string;
}

export const VERIFIED_IDENTITY_REQUIRED_ERROR = "verified_identity_required" as const;

/** Thrown when a route needs a verified user identity but the request has none. */
export class IdentityRequiredError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "IdentityRequiredError";
    this.reason = reason;
  }
}

function assertIdentityAllowedInLiveBootstrap(
  email: string | null,
  identitySource: string | null
): void {
  if (!isLiveBootstrap()) return;
  if (identitySource === AUTHENTICATED_IDENTITY_SOURCES.localFallback) {
    throw new IdentityRequiredError(
      "Verified identity is required in live bootstrap (local fallback is not allowed)."
    );
  }
  const normalized = email?.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    throw new IdentityRequiredError(
      "Verified identity is required in live bootstrap (missing authenticated email)."
    );
  }
}

export function resolveRequestUserFromEmail(email: string | null): ResolvedRequestUser {
  const normalized = email?.trim().toLowerCase();
  if (normalized && normalized.includes("@")) return { userId: userIdForEmail(normalized), email: normalized };
  return { userId: DEV_USER_ID };
}

export function resolveRequestUser(request: Request): ResolvedRequestUser {
  const email = request.headers.get(AUTHENTICATED_EMAIL_HEADER);
  const identitySource = request.headers.get(AUTHENTICATED_IDENTITY_SOURCE_HEADER);
  assertIdentityAllowedInLiveBootstrap(email, identitySource);
  // With the server subscription route enabled, no auth-unconfigured request may inherit
  // the scheduler owner's legacy local id. Verify provenance before account mapping.
  if (process.env.CODE_CLI_ENABLED === "true" && (!email?.trim().includes("@") ||
    (identitySource !== AUTHENTICATED_IDENTITY_SOURCES.authJsSession
    && identitySource !== AUTHENTICATED_IDENTITY_SOURCES.cloudflareAccess))) {
    throw new IdentityRequiredError("Verified identity required while Code CLI is enabled");
  }
  const resolved = resolveRequestUserFromEmail(email);
  const issuedAt = request.headers.get(AUTHENTICATED_SESSION_ISSUED_AT_HEADER);
  const sessionSid = request.headers.get(AUTHENTICATED_SESSION_SID_HEADER)?.trim();
  if (
    identitySource === AUTHENTICATED_IDENTITY_SOURCES.authJsSession &&
    sessionSid &&
    !isAuthServerSessionActive(sessionSid)
  ) {
    throw new Error("Session revoked or expired.");
  }
  if (
    identitySource === AUTHENTICATED_IDENTITY_SOURCES.authJsSession ||
    identitySource === AUTHENTICATED_IDENTITY_SOURCES.cloudflareAccess
  ) {
    // Legacy cookies have no explicit provider-login time. They remain valid for accounts that
    // have never been deleted, but once an identity tombstone exists the generation resolver must
    // reject a missing/stale claim instead of silently mapping it back to the fenced base account.
    return { ...resolved, userId: resolveAuthenticatedAccountGeneration(resolved.userId, issuedAt ?? "") };
  }
  return resolved;
}

/**
 * The trusted userId for this request. `_body` is accepted for call-site compatibility but ignored — body
 * `userId` is no longer an identity source.
 */
export function resolveRequestUserId(request: Request, _body?: unknown): string {
  void _body;
  return resolveRequestUser(request).userId;
}

/** Map identity failures to the API 401 contract; other errors return null (rethrow upstream). */
export function identityErrorResponse(error: unknown): Response | null {
  const reason =
    error instanceof IdentityRequiredError
      ? error.reason
      : error instanceof Error &&
          (error.message.includes("Verified identity is required in live bootstrap") ||
            error.message === "Verified identity required while Code CLI is enabled")
        ? error.message
        : null;
  if (!reason) return null;
  return Response.json(
    { ok: false, error: VERIFIED_IDENTITY_REQUIRED_ERROR, reason },
    { status: 401, headers: { "content-type": "application/json" } }
  );
}

/** Map resolveRequestUser failures that are auth/session (not server bugs) to 401 responses. */
export function authErrorResponse(error: unknown): Response | null {
  const identityDenied = identityErrorResponse(error);
  if (identityDenied) return identityDenied;
  if (!(error instanceof Error)) return null;
  if (
    /session revoked or expired/i.test(error.message) ||
    /fresh provider sign-in is required/i.test(error.message)
  ) {
    return Response.json(
      { error: error.message },
      { status: 401, headers: { "content-type": "application/json" } }
    );
  }
  return null;
}

export function resolveRequestUserOrResponse(request: Request): ResolvedRequestUser | Response {
  try {
    return resolveRequestUser(request);
  } catch (error) {
    const denied = authErrorResponse(error);
    if (denied) return denied;
    throw error;
  }
}

export function resolveRequestUserIdOrResponse(request: Request, body?: unknown): string | Response {
  try {
    return resolveRequestUserId(request, body);
  } catch (error) {
    const denied = authErrorResponse(error);
    if (denied) return denied;
    throw error;
  }
}
