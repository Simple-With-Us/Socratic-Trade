// Edge-safe (crypto-free) helper shared by `middleware.ts`. Identity headers are TRUSTED — the
// middleware sets `x-authenticated-user-email` only after verifying it, and route handlers read it via
// resolveRequestUserId. A client must therefore never be able to supply one itself. On authenticated
// routes the middleware overwrites/strips them; on PUBLIC routes (e.g. /api/webhooks, /api/health) it
// forwards the request without auth, so it must still strip these so a future public handler that reads
// identity can't be handed a forged one.

/** Header names that carry trusted identity and must never be accepted from a client. */
export const CLIENT_IDENTITY_HEADERS = ["x-authenticated-user-email", "x-user-id"] as const;

/** Remove any client-supplied identity headers in place, returning the same Headers for chaining. */
export function stripClientIdentityHeaders(headers: Headers): Headers {
  for (const name of CLIENT_IDENTITY_HEADERS) headers.delete(name);
  return headers;
}
