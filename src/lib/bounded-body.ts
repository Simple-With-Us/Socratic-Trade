// Shared streaming byte cap for inbound request bodies (webhooks, mobile auth). A
// `content-length` header is a CLIENT CLAIM, not a guarantee: it can be absent (chunked
// transfer), wrong, or an outright lie. Checking it alone (as the congress webhook route
// used to) only rejects an attacker who bothers to send an honest oversized header — it
// does nothing against a missing/understated one. This reads the body incrementally and
// aborts the moment the actual byte count exceeds the cap, regardless of what any header
// claimed.

/** Congress webhook: matches the pre-existing declared-Content-Length threshold this route
 *  already used (batches of many trade events can be a few MB). */
export const CONGRESS_WEBHOOK_MAX_BYTES = 5 * 1024 * 1024;

/** Inbound App A -> App B securities import: same wire shape as outbound share payloads (refs,
 *  prices, spx batches); 5 MB matches the congress webhook cap. */
export const SECURITIES_IMPORT_MAX_BYTES = CONGRESS_WEBHOOK_MAX_BYTES;

/** TradingView Pine `alert()` webhook: a single alert payload is a few hundred bytes; no
 *  batching. 1 MB leaves generous headroom with no prior cap to preserve. */
export const TRADINGVIEW_WEBHOOK_MAX_BYTES = 1 * 1024 * 1024;

/** Apple Sign-In mobile auth: an identityToken JWT plus an optional display name is a few
 *  KB at most. */
export const APPLE_AUTH_MAX_BYTES = 16 * 1024;

export class PayloadTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Request body exceeds the ${maxBytes}-byte limit.`);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Read `req`'s body as UTF-8 text, aborting with `PayloadTooLargeError` the moment the
 * actual byte count exceeds `maxBytes` — independent of (but fast-pathed by) any
 * `content-length` header. Callers should catch `PayloadTooLargeError` and respond 413.
 */
export async function readBodyWithLimit(req: Request, maxBytes: number): Promise<string> {
  // Fast path: an honest declared length lets us reject before reading anything.
  const declared = req.headers.get("content-length");
  if (declared) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new PayloadTooLargeError(maxBytes);
    }
  }
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new PayloadTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    // Stop pulling more of the body once we've decided (limit hit, or naturally done).
    await reader.cancel().catch(() => {});
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Buffer.from(merged.buffer, merged.byteOffset, merged.byteLength).toString("utf-8");
}

/** Convenience wrapper: read with a byte cap, then `JSON.parse`. Throws
 *  `PayloadTooLargeError` (413) or a `SyntaxError` (400, invalid JSON) — callers already
 *  distinguish these via try/catch in the existing route handlers. */
export async function readJsonWithLimit<T = unknown>(req: Request, maxBytes: number): Promise<T> {
  const text = await readBodyWithLimit(req, maxBytes);
  return JSON.parse(text) as T;
}
