// Edge-safe (crypto-free) helper shared by `middleware.ts`. Identity headers are TRUSTED — the
// middleware sets the authenticated email and its identity-source provenance, and route handlers read
// them as trusted metadata. A client must therefore never be able to supply either one itself. On authenticated
// routes the middleware overwrites/strips them; on PUBLIC routes (e.g. /api/webhooks, /api/health) it
// forwards the request without auth, so it must still strip these so a future public handler that reads
// identity can't be handed a forged one.

export const AUTHENTICATED_IDENTITY_SOURCE_HEADER = "x-authenticated-identity-source";
export const AUTHENTICATED_SESSION_ISSUED_AT_HEADER = "x-authenticated-session-issued-at";

export const AUTHENTICATED_IDENTITY_SOURCES = {
  cloudflareAccess: "cloudflare-access",
  authJsSession: "authjs-session",
  localFallback: "local-fallback"
} as const;

export type AuthenticatedIdentitySource =
  (typeof AUTHENTICATED_IDENTITY_SOURCES)[keyof typeof AUTHENTICATED_IDENTITY_SOURCES];

/** Only cryptographically/upstream-verified sources may satisfy an email-based admin check. */
export function isVerifiedIdentitySource(source: string | null): boolean {
  return (
    source === AUTHENTICATED_IDENTITY_SOURCES.cloudflareAccess ||
    source === AUTHENTICATED_IDENTITY_SOURCES.authJsSession
  );
}

/** Header names that carry trusted identity and must never be accepted from a client. */
export const CLIENT_IDENTITY_HEADERS = [
  "x-authenticated-user-email",
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_SESSION_ISSUED_AT_HEADER,
  "x-user-id"
] as const;

/** Remove any client-supplied identity headers in place, returning the same Headers for chaining. */
export function stripClientIdentityHeaders(headers: Headers): Headers {
  for (const name of CLIENT_IDENTITY_HEADERS) headers.delete(name);
  return headers;
}
