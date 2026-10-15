// Transparent text codec for large SQLite TEXT bodies.
//
// Marker is an ASCII prefix so a TEXT column never holds raw gzip bytes (SQLite
// TEXT affinity can mangle non-UTF-8). Readers that do not know the marker still
// see legacy plaintext. FTS and embeddings must run on decodeTextPayload output,
// never on the stored form.
//
// gz1: base64(gzip(utf8)) when that form is smaller than the plaintext.
// raw1: plaintext when gzip does not shrink it, so a lazy backfill can mark the
// row done without rewriting it forever.
// Unmarked text is legacy plaintext and is returned unchanged.

import zlib from "zlib";

export const TEXT_PAYLOAD_GZIP_PREFIX = "gz1:";
export const TEXT_PAYLOAD_RAW_PREFIX = "raw1:";

const GZIP_LEVEL = 6;

export function isTextPayloadMarked(stored: string | null | undefined): boolean {
  return (
    typeof stored === "string" &&
    (stored.startsWith(TEXT_PAYLOAD_GZIP_PREFIX) || stored.startsWith(TEXT_PAYLOAD_RAW_PREFIX))
  );
}

export function encodeTextPayload(plain: string): string {
  if (!plain) return plain;
  if (isTextPayloadMarked(plain)) return plain;
  const gz = zlib.gzipSync(Buffer.from(plain, "utf8"), { level: GZIP_LEVEL });
  const encoded = TEXT_PAYLOAD_GZIP_PREFIX + gz.toString("base64");
  if (encoded.length < plain.length) return encoded;
  return TEXT_PAYLOAD_RAW_PREFIX + plain;
}

export function encodeTextPayloadAsync(plain: string): Promise<string> {
  if (!plain) return Promise.resolve(plain);
  if (isTextPayloadMarked(plain)) return Promise.resolve(plain);
  return new Promise((resolve, reject) => {
    zlib.gzip(Buffer.from(plain, "utf8"), { level: GZIP_LEVEL }, (err, gz) => {
      if (err) {
        reject(err);
        return;
      }
      const encoded = TEXT_PAYLOAD_GZIP_PREFIX + gz.toString("base64");
      resolve(encoded.length < plain.length ? encoded : TEXT_PAYLOAD_RAW_PREFIX + plain);
    });
  });
}

/**
 * Restore plaintext. Legacy unmarked rows pass through. A gz1: row that does not
 * gunzip throws so callers never treat compressed bytes as a filing or transcript.
 */
export function decodeTextPayload(stored: string): string {
  if (stored.startsWith(TEXT_PAYLOAD_RAW_PREFIX)) return stored.slice(TEXT_PAYLOAD_RAW_PREFIX.length);
  if (!stored.startsWith(TEXT_PAYLOAD_GZIP_PREFIX)) return stored;
  const gz = Buffer.from(stored.slice(TEXT_PAYLOAD_GZIP_PREFIX.length), "base64");
  return zlib.gunzipSync(gz).toString("utf8");
}
