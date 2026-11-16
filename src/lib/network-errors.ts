/**
 * Shared classifiers for transport-layer failures.
 *
 * Two different things get labeled "the network died" in this codebase and they
 * must not be treated the same:
 *
 * - A **caller abort / budget timeout** (AbortController on `/api/quote`'s 6s
 *   cascade, nasdaq-calendar's 8s per-day fetch) is expected.  Log it soft so
 *   it cannot paint a lane STOPPED or mint a Sentry "connection failed".
 * - A **dead keep-alive socket** (`fetch failed` + `UND_ERR_SOCKET` /
 *   "other side closed") is transient and worth one retry.  It is still a
 *   hard health row if it survives the retry — a real outage must still page
 *   after the consecutive-failure streak.
 */

/**
 * Flatten an error and its nested `cause` chain (Pinecone 8.x wraps `TypeError: fetch failed`
 * inside `PineconeConnectionError` with a display-only outer message). Depth-capped.
 */
export function describeNetworkError(error: unknown, depth = 0): string {
  if (error == null || depth > 8) return "";
  let self = "";
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    self = `${error.name} ${error.message} ${code}`.trim();
  } else if (typeof error === "object") {
    const rec = error as { code?: unknown; message?: unknown; name?: unknown; cause?: unknown };
    self = `${rec.name ?? ""} ${rec.message ?? ""} ${rec.code ?? ""}`.trim();
    if (!self) self = String(error);
  } else {
    self = String(error);
  }
  const cause =
    error && typeof error === "object" && "cause" in error
      ? (error as { cause: unknown }).cause
      : undefined;
  const nested = cause != null ? describeNetworkError(cause, depth + 1) : "";
  return nested ? `${self} ${nested}` : self;
}

function errorText(error: unknown): string {
  return describeNetworkError(error);
}

/** Caller cancelled the request (budget, teardown).  Do not retry. */
export function isAbortOrTimeoutError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  return /this operation was aborted|the operation was aborted|\bAbortError\b|\bTimeoutError\b/i.test(
    errorText(error)
  );
}

/**
 * Socket/DNS-layer text shapes, as they appear in a Node/undici error message or on `err.cause`.
 *
 * Single source of truth: the health store classifies an already-stringified `error_text` row and
 * the RAG lane classifies a raw provider message, and the two drifting apart is exactly how
 * `ECONNRESET` ended up paging as a hard outage while the byte-identical `"fetch failed"` did not.
 * Deliberately narrow — every entry is a transport string a provider's own HTTP response body
 * cannot produce, so an `HTTP 500` or an auth rejection stays hard.
 */
const TRANSIENT_NETWORK_TEXT =
  /fetch failed|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|other side closed|socket hang up|network socket disconnected|\bECONNRESET\b|\bECONNREFUSED\b|\bECONNABORTED\b|\bETIMEDOUT\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bEPIPE\b|\bEHOSTUNREACH\b|\bENETUNREACH\b/i;

/**
 * Pinecone SDK 8.x HTTP response errors drop `HTTP ###` from `.message` (only the response body
 * text remains). Their class name is the durable status signal — treat them as hard before any
 * body-token scan (Codex P2 on #3195). `PineconeConnectionError` is intentionally absent: that
 * is the transport wrapper whose nested `fetch failed` must stay transient.
 */
const PINECONE_HTTP_RESPONSE_ERROR_NAME =
  /^Pinecone(?:BadRequest|Authorization|NotFound|Conflict|UnprocessableEntity|InternalServer|Unavailable|NotImplemented|MethodNotAllowed|UnmappedHttp|Request)Error$/;

export function isPineconeHttpResponseError(error: unknown): boolean {
  let cur: unknown = error;
  for (let depth = 0; depth < 8 && cur != null; depth++) {
    const name = (cur as { name?: string } | null)?.name;
    if (name && PINECONE_HTTP_RESPONSE_ERROR_NAME.test(name)) return true;
    cur =
      cur && typeof cur === "object" && "cause" in cur
        ? (cur as { cause: unknown }).cause
        : undefined;
  }
  return false;
}

/**
 * Same classification as `isTransientNetworkError`, for a message that is already a string.
 *
 * Explicit HTTP-status errors are rejected first: health callers include provider response bodies
 * (`HTTP <status> <body>`), and a 4xx/5xx body that happens to contain `fetch failed` /
 * `ECONNRESET` still means the request reached the provider — not a client transport blip.
 * RAG embed/rerank formats omit the "HTTP" prefix (`Embedding API failed …: ${status} ${body}`);
 * those are matched by name so a Node `fetch failed` / `ECONNREFUSED …:443` stays transient.
 * Flattened Pinecone HTTP error class names (from `describeNetworkError`) are rejected the same way.
 */
export function isTransientNetworkErrorText(text: string | null | undefined): boolean {
  if (!text) return false;
  const s = String(text);
  if (/\bHTTP\s+[1-5]\d\d\b/i.test(s)) return false;
  // RAG embed/rerank only: `Embedding API failed …: ${status} ${body}` (no "HTTP" prefix).
  // Deliberately narrow — a bare `fetch failed` / `ECONNREFUSED …:443` must stay transient.
  if (/\b(?:Embedding|Rerank)\s+API\s+failed\b[^:\n]{0,120}:\s*[1-5]\d\d\b/i.test(s)) return false;
  // PineconeBadRequestError / … — status stripped from .message; class name is the signal.
  if (
    /\bPinecone(?:BadRequest|Authorization|NotFound|Conflict|UnprocessableEntity|InternalServer|Unavailable|NotImplemented|MethodNotAllowed|UnmappedHttp|Request)Error\b/.test(
      s
    )
  ) {
    return false;
  }
  return TRANSIENT_NETWORK_TEXT.test(s);
}

/** Dead socket / DNS / reset — retry once, then count as a hard transport failure. */
export function isTransientNetworkError(error: unknown): boolean {
  if (isAbortOrTimeoutError(error)) return false;
  // Classify raw Pinecone HTTP errors by class before flattening (status not on .message).
  if (isPineconeHttpResponseError(error)) return false;
  return isTransientNetworkErrorText(errorText(error));
}

export function isCallerSignalAborted(init: { signal?: AbortSignal | null } | undefined): boolean {
  return Boolean(init?.signal?.aborted);
}

/**
 * Methods whose transport failure is safe to replay.  Deliberately the read-only set: a
 * request that never mutates state can be re-sent after a dead socket with no risk that
 * the first attempt actually landed on the far side.  `fetch()` defaults to GET, so an
 * `init` with no method is retryable.
 *
 * PUT/DELETE are idempotent by RFC 9110 and still excluded — nothing on this codebase's
 * health path uses them, and "idempotent by spec" is not the same as "safe to replay
 * against this vendor" for a write.
 */
const REPLAYABLE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True when the request may be replayed after a transport error (read-only method). */
export function isIdempotentRequest(init?: { method?: string | null } | null): boolean {
  const method = String(init?.method ?? "GET").toUpperCase();
  return REPLAYABLE_HTTP_METHODS.has(method);
}

/**
 * Fraction of the nominal delay the jitter may move a retry in either direction.
 *
 * Why jitter at all: every provider lane in this process backs off by the SAME fixed
 * multiple of the same constant, so one shared upstream blip (a DNS hiccup, a load
 * balancer cycling) puts a dozen lanes' retries on the identical millisecond and the
 * retry burst looks exactly like the outage it is trying to ride out.  Spreading the
 * retries over a window de-synchronizes them.
 */
export const TRANSIENT_RETRY_JITTER_RATIO = 0.3;

/**
 * Bounded, jittered backoff for retry attempt `attempt` (0-based).  Linear in the attempt
 * number — the same escalation the fixed backoff always used — then scattered by up to
 * ±`TRANSIENT_RETRY_JITTER_RATIO`.  Never negative, and never longer than
 * `(1 + ratio) x baseMs x (attempt + 1)`, so a caller's timeout budget stays predictable.
 *
 * `random` is injectable so tests can pin the bounds instead of asserting on a range.
 */
export function jitteredBackoffMs(baseMs: number, attempt: number, random: () => number = Math.random): number {
  const nominal = Math.max(0, baseMs) * (Math.max(0, attempt) + 1);
  if (nominal <= 0) return 0;
  const spread = nominal * TRANSIENT_RETRY_JITTER_RATIO;
  return Math.max(0, Math.round(nominal - spread + random() * spread * 2));
}

/** Parse `Retry-After` from a Response (delta-seconds or HTTP-date).  Returns ms to wait. */
export function retryAfterDelayMs(response: Response, now = Date.now()): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const asSeconds = Number.parseInt(raw.trim(), 10);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - now);
  return undefined;
}
