// Transparent text codec for large SQLite TEXT bodies.
//
// Marker is an ASCII prefix so a TEXT column never holds raw gzip bytes (SQLite
// TEXT affinity can mangle non-UTF-8). Readers that do not know the marker still
// see legacy plaintext. FTS and embeddings must run on decodeTextPayload output,
// never on the stored form.
//
// gz1: base64(gzip(utf8)) when that form is smaller than the plaintext.
// raw1:<utf16Length>:<plaintext> when gzip does not shrink it. The length frame
// keeps a plaintext that itself starts with gz1: or raw1: from being stripped
// on read, and lets encode stay idempotent on a value it already produced.
// Legacy raw1: without a frame (this branch, before the frame) still decodes
// by stripping the prefix once.
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

/** Codec column value for a stored body. Null when the text is still legacy plaintext. */
export function textPayloadCodecTag(stored: string): "gz1" | "raw1" | null {
  if (stored.startsWith(TEXT_PAYLOAD_GZIP_PREFIX)) return "gz1";
  if (stored.startsWith(TEXT_PAYLOAD_RAW_PREFIX)) return "raw1";
  return null;
}

function framedRawBody(stored: string): string | null {
  if (!stored.startsWith(TEXT_PAYLOAD_RAW_PREFIX)) return null;
  const rest = stored.slice(TEXT_PAYLOAD_RAW_PREFIX.length);
  const match = /^(\d+):/.exec(rest);
  if (!match) return null;
  const body = rest.slice(match[0].length);
  if (body.length !== Number(match[1])) return null;
  return body;
}

function rawFrame(plain: string): string {
  return `${TEXT_PAYLOAD_RAW_PREFIX}${plain.length}:${plain}`;
}

function chooseEncoded(plain: string, gz: Buffer): string {
  const encoded = TEXT_PAYLOAD_GZIP_PREFIX + gz.toString("base64");
  return encoded.length < plain.length ? encoded : rawFrame(plain);
}

function gzipBytes(stored: string): Buffer | null {
  if (!stored.startsWith(TEXT_PAYLOAD_GZIP_PREFIX)) return null;
  return Buffer.from(stored.slice(TEXT_PAYLOAD_GZIP_PREFIX.length), "base64");
}

function gunzipAsync(bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.gunzip(bytes, (err, out) => {
      if (err) reject(err);
      else resolve(out);
    });
  });
}

export function encodeTextPayload(plain: string): string {
  if (!plain) return plain;
  if (framedRawBody(plain) != null) return plain;
  if (plain.startsWith(TEXT_PAYLOAD_GZIP_PREFIX)) {
    try {
      const bytes = gzipBytes(plain);
      if (bytes && zlib.gunzipSync(bytes).length >= 0) return plain;
    } catch {
      // Plaintext that starts with the gzip marker. Fall through and frame it.
    }
  }
  const gz = zlib.gzipSync(Buffer.from(plain, "utf8"), { level: GZIP_LEVEL });
  return chooseEncoded(plain, gz);
}

export function encodeTextPayloadAsync(plain: string): Promise<string> {
  if (!plain) return Promise.resolve(plain);
  if (framedRawBody(plain) != null) return Promise.resolve(plain);
  const existingGzip = plain.startsWith(TEXT_PAYLOAD_GZIP_PREFIX) ? gzipBytes(plain) : null;
  if (existingGzip) {
    return gunzipAsync(existingGzip).then(
      () => plain,
      () => gzipPlain(plain)
    );
  }
  return gzipPlain(plain);
}

function gzipPlain(plain: string): Promise<string> {
  return new Promise((resolve, reject) => {
    zlib.gzip(Buffer.from(plain, "utf8"), { level: GZIP_LEVEL }, (err, gz) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(chooseEncoded(plain, gz));
    });
  });
}

/**
 * Restore plaintext. Legacy unmarked rows pass through. A gz1: row that does not
 * gunzip throws so callers never treat compressed bytes as a filing or transcript.
 */
export function decodeTextPayload(stored: string): string {
  const framed = framedRawBody(stored);
  if (framed != null) return framed;
  if (stored.startsWith(TEXT_PAYLOAD_RAW_PREFIX)) return stored.slice(TEXT_PAYLOAD_RAW_PREFIX.length);
  if (!stored.startsWith(TEXT_PAYLOAD_GZIP_PREFIX)) return stored;
  const gz = gzipBytes(stored);
  if (!gz) throw new Error("gz1 payload is not base64");
  return zlib.gunzipSync(gz).toString("utf8");
}

export async function decodeTextPayloadAsync(stored: string): Promise<string> {
  const framed = framedRawBody(stored);
  if (framed != null) return framed;
  if (stored.startsWith(TEXT_PAYLOAD_RAW_PREFIX)) return stored.slice(TEXT_PAYLOAD_RAW_PREFIX.length);
  if (!stored.startsWith(TEXT_PAYLOAD_GZIP_PREFIX)) return stored;
  const gz = gzipBytes(stored);
  if (!gz) throw new Error("gz1 payload is not base64");
  const out = await gunzipAsync(gz);
  return out.toString("utf8");
}
