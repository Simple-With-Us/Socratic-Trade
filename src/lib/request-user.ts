// Resolve the authenticated app userId for a request.
//
// SECURITY: identity metadata is established by `middleware.ts`, which strips client-supplied hints
// and forwards either a verified upstream email or the explicit auth-unconfigured local fallback.
// We map that middleware-supplied email → a stable userId here. We NEVER trust a client-supplied
// `x-user-id`, `?userId`, or body `userId` — those were the old IDOR vectors. Security-sensitive role
// checks must additionally inspect middleware's identity-source provenance; see `auth/admin.ts`.

import { DEV_USER_ID, userIdForEmail } from "./auth/identity";
import { isLiveBootstrap } from "./auth-secret-guard";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES,
  AUTHENTICATED_SESSION_ISSUED_AT_HEADER
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

function assertIdentityAllowedInLiveBootstrap(
  email: string | null,
  identitySource: string | null
): void {
  if (!isLiveBootstrap()) return;
  if (identitySource === AUTHENTICATED_IDENTITY_SOURCES.localFallback) {
    throw new Error("Verified identity is required in live bootstrap (local fallback is not allowed).");
  }
  const normalized = email?.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    throw new Error("Verified identity is required in live bootstrap (missing authenticated email).");
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
    throw new Error("Verified identity required while Code CLI is enabled");
  }
  const resolved = resolveRequestUserFromEmail(email);
  const issuedAt = request.headers.get(AUTHENTICATED_SESSION_ISSUED_AT_HEADER);
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
