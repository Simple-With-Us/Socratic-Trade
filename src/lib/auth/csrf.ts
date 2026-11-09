// Edge-safe CSRF guard (crypto-free; importable from `middleware.ts`).
//
// This app uses header-based identity (a trusted `x-authenticated-user-email` set by middleware after a
// verified upstream login). Because the browser attaches that ambient identity to ANY same-site request,
// a cross-site form/`fetch` POST could ride the user's session — the classic CSRF vector. We close it the
// way header-identity apps should: by asserting the request is SAME-ORIGIN before any state change.
//
// We use a defense-in-depth pair, either of which is sufficient to ALLOW:
//   1. `Sec-Fetch-Site` — set by modern browsers, not forgeable by page JS. `same-origin`/`none` are safe;
//      `cross-site`/`same-site` are rejected for mutations.
//   2. `Origin` / `Referer` — must match the request host. Covers older browsers that omit Sec-Fetch-Site.
//
// Only state-changing methods on `/api/*` are guarded. Public prefixes (health, webhooks) are exempt — the
// webhook receiver does its own shared-secret/HMAC auth and is called by non-browser senders that have no
// Origin. Server-to-server and curl callers (no Origin, no Sec-Fetch-Site) are allowed: they are not
// browsers carrying ambient cookies, so they are not a CSRF vector, and blocking them would break the
// webhook prefix and CLI/cron callers.

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Methods that can change server state and therefore need a same-origin assertion. */
export function isStateChangingMethod(method: string): boolean {
  return STATE_CHANGING_METHODS.has(method.toUpperCase());
}

function hostFromUrl(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

export interface CsrfCheckInput {
  method: string;
  /** The request URL (used to learn the expected host). */
  url: string;
  secFetchSite: string | null;
  origin: string | null;
  referer: string | null;
  /** Optional forwarded host (Next/edge sets `x-forwarded-host` behind a proxy/tunnel). */
  forwardedHost?: string | null;
  /** The `Host` header. */
  host?: string | null;
}

export interface CsrfCheckResult {
  ok: boolean;
  /** Short machine reason — handy for tests and logging. */
  reason: string;
}

/**
 * Decide whether a request passes the same-origin CSRF check. Returns `ok: true` for:
 *  - non-state-changing methods (GET/HEAD/OPTIONS),
 *  - `Sec-Fetch-Site: same-origin` | `none`,
 *  - an `Origin`/`Referer` whose host matches the request host,
 *  - requests with NO browser-origin signals at all (server-to-server, curl, webhook senders).
 *
 * Returns `ok: false` only when a browser explicitly signals a cross-site context, i.e. when we have a
 * positive cross-origin signal — never on ambiguity (fail-open on missing signals, fail-closed on a
 * proven mismatch).
 */
export function checkSameOrigin(input: CsrfCheckInput): CsrfCheckResult {
  if (!isStateChangingMethod(input.method)) return { ok: true, reason: "safe-method" };

  const sfs = input.secFetchSite?.toLowerCase() ?? null;
  if (sfs) {
    // Sec-Fetch-Site is browser-set and unforgeable by page script — trust it when present.
    if (sfs === "same-origin" || sfs === "none") return { ok: true, reason: "sec-fetch-site-ok" };
    return { ok: false, reason: `sec-fetch-site-${sfs}` };
  }

  const expectedHost = input.forwardedHost?.trim() || input.host?.trim() || hostFromUrl(input.url);

  // Fall back to Origin / Referer host matching for browsers that don't send Sec-Fetch-Site.
  const originValue = input.origin && input.origin !== "null" ? input.origin : null;
  if (originValue) {
    const originHost = hostFromUrl(originValue);
    if (!originHost) return { ok: false, reason: "origin-unparseable" };
    return originHost === expectedHost
      ? { ok: true, reason: "origin-match" }
      : { ok: false, reason: "origin-mismatch" };
  }

  if (input.referer) {
    const refererHost = hostFromUrl(input.referer);
    if (refererHost) {
      return refererHost === expectedHost
        ? { ok: true, reason: "referer-match" }
        : { ok: false, reason: "referer-mismatch" };
    }
  }

  // No browser-origin signal at all → not an ambient-credential browser request. Allow (fail-open):
  // covers server-to-server, curl, cron, and webhook senders. Identity/auth is enforced separately.
  return { ok: true, reason: "no-browser-origin-signal" };
}
