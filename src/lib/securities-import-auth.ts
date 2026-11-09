// Bearer-secret verification for the congress.trade (App A) securities-import receiver.
//
// Kept in its OWN module (imported only by the Node route handler) so the `crypto` dependency stays
// out of any edge-bundled chain. The receiver is DEFAULT-CLOSED:
// with no APP_B_INGEST_TOKEN configured, every write is rejected (no unauthenticated write path).

import crypto from "crypto";

/** The App B inbound-import bearer secret (server-only; trimmed; empty → undefined). */
export function securitiesImportToken(): string | undefined {
  const t = (process.env.APP_B_INGEST_TOKEN ?? "").trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Constant-time verify of the inbound-import bearer secret (APP_B_INGEST_TOKEN). Returns false when
 * no secret is configured (receiver closed by default) or the token is absent/mismatched.
 */
export function verifySecuritiesImportToken(req: Request): boolean {
  const expected = securitiesImportToken();
  if (!expected) return false; // no secret configured → reject all writes
  const header = (req.headers.get("authorization") ?? "").trim();
  const provided = /^bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? "";
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual throws on length mismatch
  return crypto.timingSafeEqual(a, b);
}
