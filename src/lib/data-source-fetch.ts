/**
 * src/lib/data-source-fetch.ts
 *
 * Single egress decision point for market-data/provider traffic: WHICH fetch
 * implementation a data-source call uses, and what happens when the proxy is
 * down. Everything else (qdrant, litestream, APNs, Sentry, OpenRouter, broker
 * order APIs, localhost, Coolify-internal hosts) never touches this module and
 * stays on direct egress — proxying is opt-in per call site, so a new internal
 * service can never accidentally start routing through the residential proxy.
 *
 * Resolution order:
 *   1. The request's user proxy (user_proxy_settings, per-user — owner request
 *      2026-09-25) when configured and enabled.
 *   2. Operator env: RESIDENTIAL_PROXY_URL / RESIDENTIAL_PROXY_HOST(+parts) /
 *      HTTPS_PROXY / HTTP_PROXY (CT parity — see proxy-fetch.ts).
 *   3. DEFAULT_RESIDENTIAL_PROXY_URL (Mango on the WireGuard mesh), unless
 *      disabled with RESIDENTIAL_PROXY_URL=off.
 *
 * Failure behavior when the proxy is down (explicit, per user setting or
 * RESIDENTIAL_PROXY_FAILURE_MODE):
 *   fail_soft   default, CT parity: proxy-leg transport error → rate-limited
 *               warning + this request retried on direct egress. Trading-safe:
 *               a dead home proxy degrades data freshness/identity, never the
 *               app's ability to serve.
 *   fail_closed proxy-leg transport error → the error propagates; the provider
 *               reads as down and the cascade moves to the next source. No
 *               request ever leaves from the datacenter IP. Pick this when
 *               re-identifying the datacenter IP to a blocking source is worse
 *               than missing data.
 *
 * Only PROXY-LEG failures trigger fallback: when the proxy answers with an
 * HTTP error (e.g. tinyproxy 502 because the UPSTREAM is unreachable), that
 * response is returned as-is — direct egress would get the same upstream
 * answer and would only re-expose the datacenter IP.
 */

import "server-only";
import {
  createProxiedFetch,
  isProxyLegError,
  PROXY_LEG_TIMEOUT_MS,
  resolveProxyFailureMode,
  resolveResidentialProxyUrl,
  safeProxyHostForLog,
  warnProxyFallback,
  type ProxyFailureMode,
  type ResidentialProxyEnv
} from "./proxy-fetch";
import { resolveUserProxy } from "./user-proxy-settings";
import { recordProxyUse } from "./proxy-use-log";

/** Services that always use direct egress (no proxy, no fallback). Two reasons qualify:
 *   - "usage-monitor" → our own infra, not a third-party data source
 *   - "fred"          → api.stlouisfed.org does NOT block datacenter IPs (direct
 *                       egress succeeds in ~0.24s vs ~10s through the residential
 *                       proxy); the residential proxy exists for Senate/House
 *                       scraping (Imperva anti-bot), not for FRED. See
 *                       `fetchFredSeries` for the full reasoning. */
export const PROXY_EXCLUDED_SERVICES: ReadonlySet<string> = new Set([
  "usage-monitor",
  "fred"
]);

export type DataSourceProxySource = "user" | "env" | "default" | "none";

export interface DataSourceProxyResolution {
  proxyUrl?: string;
  source: DataSourceProxySource;
  failureMode: ProxyFailureMode;
}

/** Test-only dependency injection point; production callers never pass this. */
export interface DataSourceFetchDeps {
  env?: ResidentialProxyEnv;
  resolveUserProxyFn?: typeof resolveUserProxy;
  directFetch?: typeof fetch;
  proxiedFetchFactory?: (proxyUrl: string) => typeof fetch;
}

export function resolveDataSourceProxy(
  userId?: string,
  deps: DataSourceFetchDeps = {}
): DataSourceProxyResolution {
  const userProxy = (deps.resolveUserProxyFn ?? resolveUserProxy)(userId);
  if (userProxy) {
    return { proxyUrl: userProxy.proxyUrl, source: "user", failureMode: userProxy.failureMode };
  }

  const env = deps.env;
  const configured = resolveResidentialProxyUrl(env, { allowDefault: false });
  if (configured) {
    return { proxyUrl: configured, source: "env", failureMode: resolveProxyFailureMode(env) };
  }
  const withDefault = resolveResidentialProxyUrl(env);
  if (withDefault) {
    return { proxyUrl: withDefault, source: "default", failureMode: resolveProxyFailureMode(env) };
  }
  return { source: "none", failureMode: resolveProxyFailureMode(env) };
}

/** True when the request TARGET is loopback or a literal private/internal IP —
 *  such targets always bypass the proxy no matter what is configured. */
export function isInternalFetchTarget(url: string | URL): boolean {
  let host: string;
  try {
    host = new URL(typeof url === "string" ? url : url.toString()).hostname.toLowerCase();
  } catch {
    return false; // unparseable: let fetch itself fail normally
  }
  host = host.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return true;
  if (host === "::1" || host === "::") return true;
  // Bare single-label hostnames (Docker/compose service names like
  // "qdrant-st", intranet short names) are internal by definition - no
  // public DNS name is dotless.
  if (!host.includes(".")) return true;
  const parts = host.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const [a, b] = parts.map(Number);
    if (a === 127 || a === 0) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

/**
 * Hostname of the data-source request target. Never the full URL: query
 * strings can carry credentials or tokens, and bodies are never logged.
 */
function safeDestinationHostForLog(input: RequestInfo | URL): string {
  try {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const host = new URL(raw).hostname;
    return host || "(unparseable)";
  } catch {
    return "(unparseable)";
  }
}

/**
 * Short error class for the log: the error's `code` (ECONNREFUSED,
 * UND_ERR_CONNECT_TIMEOUT, ...), walking the cause chain the same way
 * isProxyLegError does, else its `name` (AbortError, ...). Never the message —
 * messages can embed request URLs carrying credentials or tokens.
 */
function errorClassForLog(error: unknown): string {
  if (error instanceof Error) {
    let current: unknown = error;
    const visited = new Set<Error>();
    for (let depth = 0; depth <= 4 && current instanceof Error && !visited.has(current); depth++) {
      visited.add(current);
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && code.length > 0) return code;
      current = current.cause;
    }
    if (error.name && error.name.length > 0) return error.name;
    return "Error";
  }
  if (typeof error === "string" && error.length > 0) return "thrown-string";
  return "unknown";
}

/**
 * Fetch a data-source URL with per-user/operator residential-proxy egress
 * applied. Drop-in for `fetch` at data-source call sites.
 */
export async function dataSourceFetch(
  url: string | URL,
  init?: RequestInit,
  opts?: { userId?: string; service?: string },
  deps: DataSourceFetchDeps = {}
): Promise<Response> {
  const directFetch = deps.directFetch ?? globalThis.fetch;

  if (opts?.service && PROXY_EXCLUDED_SERVICES.has(opts.service)) {
    // Additive telemetry only — fetch behavior unchanged.
    recordProxyUse({ usedProxy: false, source: "none", host: null, fallback: false, service: opts.service });
    return directFetch(url, init);
  }
  if (isInternalFetchTarget(url)) {
    recordProxyUse({ usedProxy: false, source: "none", host: null, fallback: false, service: opts?.service });
    return directFetch(url, init);
  }

  const resolution = resolveDataSourceProxy(opts?.userId, deps);
  if (!resolution.proxyUrl) {
    recordProxyUse({ usedProxy: false, source: resolution.source, host: null, fallback: false, service: opts?.service });
    return directFetch(url, init);
  }

  // A caller signal is the deadline.  A fixed 3s cap truncates lanes that
  // need 4-5s to headers through a slow but working residential proxy, then
  // duplicates the request on direct egress, which anti-bot sources reject.
  // The cap remains only when nothing else bounds the leg.
  const perLegTimeoutMs = init?.signal ? undefined : PROXY_LEG_TIMEOUT_MS;
  const proxyHost = safeProxyHostForLog(resolution.proxyUrl); // host:port only, never credentials
  const destination = safeDestinationHostForLog(url);
  // The single log line for this proxied request: timestamp, destination
  // host, and outcome (HTTP status on response, error class on throw).
  // Recorded once the outcome is known, so each proxied request has exactly
  // one entry. Logging stays additive — fetch behavior is unchanged.
  const proxyUseLine = {
    usedProxy: true as const,
    source: resolution.source,
    host: proxyHost,
    fallback: false,
    service: opts?.service,
    destination
  };
  const proxiedFetch = (deps.proxiedFetchFactory ?? ((proxyUrl: string) =>
    createProxiedFetch(proxyUrl, undefined, { proxyTimeoutMs: perLegTimeoutMs })))(
    resolution.proxyUrl
  );
  try {
    const res = await proxiedFetch(url, init);
    recordProxyUse({ ...proxyUseLine, statusCode: res.status });
    return res;
  } catch (error) {
    // Caller cancellation is an outcome, not evidence of a broken proxy.
    // Keep its one entry without inflating the watchdog's proxyErrors count.
    if (init?.signal?.aborted) {
      recordProxyUse({ ...proxyUseLine, cancelled: true });
      throw error;
    }
    recordProxyUse({ ...proxyUseLine, errorClass: errorClassForLog(error) });
    if (!isProxyLegError(error)) throw error;
    if (resolution.failureMode === "fail_closed") {
      throw new Error(
        `data-source proxy ${safeProxyHostForLog(resolution.proxyUrl)} unreachable and failure mode is fail_closed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    warnProxyFallback(resolution.proxyUrl, error);
    // Visible fail_soft fallback: a second entry, not a silent one. This is
    // the direct-egress retry — not routed through the proxy — so it keeps
    // usedProxy:false; it carries the destination for watchdog correlation.
    recordProxyUse({
      usedProxy: false,
      source: resolution.source,
      host: proxyHost,
      fallback: true,
      service: opts?.service,
      destination
    });
    return directFetch(url, init);
  }
}
