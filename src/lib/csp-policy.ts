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

/**
 * Default policy.  script-src is nonce + strict-dynamic, with 'unsafe-eval' only in
 * development (React's dev overlay).  No 'unsafe-inline' on scripts.
 *
 * style-src keeps 'unsafe-inline' on purpose.  Tailwind v4 and Next (including
 * styled-jsx) emit inline style attributes and <style> tags that are not tied to
 * this request's nonce.  A nonce or hash in style-src would also make the browser
 * ignore 'unsafe-inline', so styles stay loose until a dedicated hash pass.
 * Script enforcement does not depend on that.
 */
export function buildDefaultCsp(nonce: string, env: NodeJS.ProcessEnv = process.env): string {
  const devEval = env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${devEval}`,
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
export function stampCspRequestHeaders(headers: Headers, nonce: string, env: NodeJS.ProcessEnv = process.env): void {
  headers.delete(CSP_NONCE_HEADER);
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  if (!cspEnabled(env) || cspPolicyOverride(env)) return;
  headers.set(CSP_NONCE_HEADER, nonce);
  headers.set("Content-Security-Policy", buildDefaultCsp(nonce, env));
}
