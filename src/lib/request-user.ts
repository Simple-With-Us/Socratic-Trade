// Resolve the authenticated app userId for a request.
//
// SECURITY: identity is established by `middleware.ts` (verified Auth.js session), which forwards
// a trusted `x-authenticated-user-email` header and strips client-supplied hints.
// We map that verified email → a stable userId here. We NEVER trust a client-supplied `x-user-id`,
// `?userId`, or body `userId` — those were the old IDOR vectors. In production, middleware 401s any
// request that lacks a verified identity, so the dev fallback below is only reachable in dev/test.

import { DEV_USER_ID, userIdForEmail } from "./auth/identity";

/** Header set by middleware after it verifies identity. Client-supplied copies are stripped by middleware. */
export const AUTHENTICATED_EMAIL_HEADER = "x-authenticated-user-email";

/** Back-compat: the dev/test fallback identity. */
export const DEFAULT_REQUEST_USER_ID = DEV_USER_ID;

export interface ResolvedRequestUser {
  userId: string;
  email?: string;
}

export function resolveRequestUserFromEmail(email: string | null): ResolvedRequestUser {
  const normalized = email?.trim().toLowerCase();
  if (normalized && normalized.includes("@")) return { userId: userIdForEmail(normalized), email: normalized };
  return { userId: DEV_USER_ID };
}

export function resolveRequestUser(request: Request): ResolvedRequestUser {
  return resolveRequestUserFromEmail(request.headers.get(AUTHENTICATED_EMAIL_HEADER));
}

/**
 * The trusted userId for this request. `_body` is accepted for call-site compatibility but ignored — body
 * `userId` is no longer an identity source.
 */
export function resolveRequestUserId(request: Request, _body?: unknown): string {
  return resolveRequestUser(request).userId;
}
