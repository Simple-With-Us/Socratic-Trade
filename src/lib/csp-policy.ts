/**
 * Strict per-request Content-Security-Policy (ST-2789).
 *
 * CSP_ENABLED still gates emission.  CSP_REPORT_ONLY stays report-only unless it is
 * explicitly falsy.  CSP_POLICY, when set, replaces this string entirely.
 *
 * The nonce is Web Crypto so the edge middleware can mint one without Node's
 * crypto module.  Next.js reads it from the forwarded request's
 * Content-Security-Policy header (see getScriptNonceFromHeaders) and from x-nonce.
 */

export const CSP_NONCE_HEADER = "x-nonce";

/** Reporting-Endpoints group name referenced by the report-to directive. */
export const CSP_REPORT_GROUP = "csp-endpoint";

/** Same-origin collector.  Relative so it follows the host that served the page. */
export const CSP_REPORT_PATH = "/api/csp-report";

/**
 * sha256 of the two constant inline scripts in the root layout (theme bootstrap,
 * then the PWA unregister script).  Dynamic pages allow them by hash so the layout
 * does not have to read `headers()` and opt every route into dynamic rendering.
 * `test/middleware-csp.test.ts` recomputes these from the script sources.
 */
export const LAYOUT_SCRIPT_HASHES = [
  "sha256-BkvDCth/QzEewnzgWKkh4CxJQKd5eaHgbtJL5b3T8T8=",
  "sha256-u1teihVV9FYtrpqADi13pPRy8sqT9s/2Z5XtGZKkvus="
] as const;

/**
 * Replaced after `next build` by `scripts/stamp-csp-static-hashes.mjs` with a JSON
 * object of pathname to sha256 sources, taken from that build's prerendered HTML.
 * Left as this sentinel, static routes stay report-only (see `buildStaticFallbackCsp`).
 */
export const CSP_STATIC_HASH_TABLE = "__ST2789_STATIC_HASHES__";

/** Routes that stay on hourly ISR.  A nonce cannot be cached with their HTML. */
export const STATIC_CSP_PATHS = ["/welcome", "/privacy-policy", "/terms-and-conditions"] as const;

const NONCE_BYTES = 16;

function flagOn(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function flagExplicitlyOff(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

export function cspEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env.CSP_ENABLED);
}

/** Operator override.  When present, the nonce policy is not used. */
export function cspPolicyOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const custom = env.CSP_POLICY?.trim();
  return custom ? custom : undefined;
}

export function cspIsReportOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return !flagExplicitlyOff(env.CSP_REPORT_ONLY);
}

export function cspHeaderName(env: NodeJS.ProcessEnv = process.env): "Content-Security-Policy" | "Content-Security-Policy-Report-Only" {
  return cspIsReportOnly(env) ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
}

/** 128-bit nonce, standard base64.  Matches Next's `'nonce-...'` token parser. */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function devEvalSource(env: NodeJS.ProcessEnv): string {
  return env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
}

/**
 * style-src keeps 'unsafe-inline' on purpose.  Tailwind v4 and Next (including
 * styled-jsx) emit inline style attributes and <style> tags that are not tied to
 * this request's nonce.  A nonce or hash in style-src would also make the browser
 * ignore 'unsafe-inline', so styles stay loose until a dedicated hash pass.
 */
function cspDirectives(scriptSrc: string): string {
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    // Sentry Replay boots a blob: worker.  worker-src does not inherit strict-dynamic.
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`
  ].join("; ");
}

/**
 * Nonce policy for dynamically rendered routes.  script-src is nonce + the two
 * layout script hashes + strict-dynamic.  'unsafe-eval' is added only in
 * development.  There is no 'unsafe-inline' on scripts.
 */
export function buildDefaultCsp(nonce: string, env: NodeJS.ProcessEnv = process.env): string {
  const hashes = LAYOUT_SCRIPT_HASHES.map((hash) => `'${hash}'`).join(" ");
  return cspDirectives(
    `script-src 'self' 'nonce-${nonce}' ${hashes} 'strict-dynamic'${devEvalSource(env)}`
  );
}

/**
 * Hash policy for prerendered HTML.  No nonce and no strict-dynamic: the cached
 * document's `<script src>` tags do not carry a nonce, so `'self'` has to allow
 * the Next chunks.  strict-dynamic would ignore that host allowlist.
 */
export function buildHashedCsp(hashes: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const sources = hashes.map((hash) => `'${hash}'`).join(" ");
  return cspDirectives(`script-src 'self' ${sources}${devEvalSource(env)}`);
}

/**
 * Used only when this build did not stamp hashes for a static route (local dev,
 * and tests).  Always sent as report-only, including when CSP_REPORT_ONLY=0,
 * because enforcing `'unsafe-inline'` is not the nonce policy and a nonce would
 * not match the cached HTML.
 */
export function buildStaticFallbackCsp(env: NodeJS.ProcessEnv = process.env): string {
  return cspDirectives(`script-src 'self' 'unsafe-inline'${devEvalSource(env)}`);
}

export function normalizeCspPath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

export function loadStaticHashTable(raw: string = CSP_STATIC_HASH_TABLE): Record<string, string[]> | undefined {
  // The sentinel is the only non-JSON value.  Comparing to it would duplicate the
  // string in the bundle, and the post-build stamp replaces that string once.
  if (!raw.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const table: Record<string, string[]> = {};
    for (const [path, hashes] of Object.entries(parsed)) {
      if (!Array.isArray(hashes) || hashes.some((hash) => typeof hash !== "string")) continue;
      table[path] = hashes;
    }
    return table;
  } catch {
    return undefined;
  }
}

export type CspRouteMode = "nonce" | "hash" | "static-fallback";

export function cspRouteMode(pathname: string, table = loadStaticHashTable()): CspRouteMode {
  const path = normalizeCspPath(pathname);
  const hashes = table?.[path];
  if (hashes && hashes.length > 0) return "hash";
  if ((STATIC_CSP_PATHS as readonly string[]).includes(path)) return "static-fallback";
  return "nonce";
}

export type CspDecision = {
  headerName: "Content-Security-Policy" | "Content-Security-Policy-Report-Only";
  policy: string;
  forwardNonce: boolean;
};

export function resolveCspDecision(
  pathname: string,
  nonce: string,
  env: NodeJS.ProcessEnv = process.env,
  hashTableRaw?: string
): CspDecision {
  const override = cspPolicyOverride(env);
  if (override) {
    return { headerName: cspHeaderName(env), policy: override, forwardNonce: false };
  }
  const table = hashTableRaw === undefined ? loadStaticHashTable() : loadStaticHashTable(hashTableRaw);
  const mode = cspRouteMode(pathname, table);
  if (mode === "hash") {
    const hashes = table?.[normalizeCspPath(pathname)] ?? [];
    return { headerName: cspHeaderName(env), policy: buildHashedCsp(hashes, env), forwardNonce: false };
  }
  if (mode === "static-fallback") {
    return {
      headerName: "Content-Security-Policy-Report-Only",
      policy: buildStaticFallbackCsp(env),
      forwardNonce: false
    };
  }
  return { headerName: cspHeaderName(env), policy: buildDefaultCsp(nonce, env), forwardNonce: true };
}

export function resolveCspPolicy(nonce: string, env: NodeJS.ProcessEnv = process.env): string {
  return cspPolicyOverride(env) ?? buildDefaultCsp(nonce, env);
}

export function reportingEndpointsHeader(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!cspEnabled(env) || cspPolicyOverride(env)) return undefined;
  return `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;
}

/**
 * Forward the nonce to the App Router.  Next.js only nonces its own scripts when
 * the request carries a CSP with `'nonce-...'`, so the request header is the
 * enforcing name even while the browser-facing header stays report-only.
 * A client-supplied nonce or CSP is dropped first.
 */
export function stampCspRequestHeaders(
  headers: Headers,
  nonce: string,
  pathname: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  headers.delete(CSP_NONCE_HEADER);
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  if (!cspEnabled(env)) return;
  const decision = resolveCspDecision(pathname, nonce, env);
  if (!decision.forwardNonce) return;
  headers.set(CSP_NONCE_HEADER, nonce);
  headers.set("Content-Security-Policy", decision.policy);
}
