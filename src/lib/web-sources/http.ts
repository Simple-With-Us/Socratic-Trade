// Polite HTTP helpers for backend scrapers/readers.
//
// Public disclosure sites (Senate eFD, SEC EDGAR) ask callers to identify
// themselves and not hammer the servers. These helpers centralize a descriptive
// User-Agent, per-request timeouts, light retry, and a sequential rate limiter so
// a single refresh can't burst dozens of parallel requests at a .gov host.

import { resolveApiKey } from "../db";

/** Browser-like UA for sites that block obvious bots (Senate eFD, Capitol Trades). */
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * SEC requires a descriptive User-Agent with contact info (fair-access policy).
 * Overridable via SEC_EDGAR_USER_AGENT for users who want to use their own contact.
 */
/** Contact email is required. EDGAR 403s a User-Agent that has no address. */
export const SEC_EDGAR_FALLBACK_UA = "Socratic Trade research jay@socratic.trade";

export function secUserAgent(): string {
  return resolveApiKey("sec_edgar_user_agent", "local") ?? SEC_EDGAR_FALLBACK_UA;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: BodyInit;
  timeoutMs?: number;
  retries?: number;
  redirect?: RequestRedirect;
}

/** fetch() with an AbortController timeout and one retry on network error / HTTP 429/5xx. */
export async function politeFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  const { headers, method = "GET", body, timeoutMs = 9000, retries = 1, redirect = "follow" } = options;
  let lastError: unknown;
  const isSec = url.includes(".sec.gov");
  // EDGAR hard-403s requests without a descriptive User-Agent (fair-access policy), and a call
  // site that forgets to pass one is invisible until production traffic dies — the SEC ingest
  // worker shipped exactly that way. Inject the shared SEC UA whenever the caller didn't set one.
  let effectiveHeaders = headers;
  if (isSec && !Object.keys(headers ?? {}).some((k) => k.toLowerCase() === "user-agent")) {
    effectiveHeaders = { ...(headers ?? {}), "user-agent": secUserAgent() };
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (isSec) {
      const { secLimiter } = await import("./sec-limiter");
      await secLimiter.acquire();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, body, headers: effectiveHeaders, redirect, cache: "no-store", signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429 && isSec) {
        const { secLimiter } = await import("./sec-limiter");
        secLimiter.report429(res.headers.get("retry-after"));
      }
      if (res.status === 403 && isSec) {
        // EDGAR signals automated-access blocks with 403, not 429 — an IP-level stop signal.
        const { secLimiter } = await import("./sec-limiter");
        secLimiter.report403();
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      return res;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Request failed: ${url}`);
}

export async function politeFetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const res = await politeFetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export async function politeFetchJson<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
  const res = await politeFetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/** Run async tasks one at a time with a fixed delay between them (server-friendly). */
export async function runRateLimited<T, R>(
  items: T[],
  delayMs: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i++) {
    out.push(await fn(items[i], i));
    if (i < items.length - 1 && delayMs > 0) await sleep(delayMs);
  }
  return out;
}

/** Collect Set-Cookie values from a response into a name=value cookie jar object. */
export function mergeSetCookies(jar: Record<string, string>, res: Response): Record<string, string> {
  const withGetSetCookie = res.headers as unknown as { getSetCookie?: () => string[] };
  const raw =
    typeof withGetSetCookie.getSetCookie === "function"
      ? withGetSetCookie.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""].filter(Boolean);
  for (const cookie of raw) {
    const first = cookie.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) jar[first.slice(0, eq).trim()] = first.slice(eq + 1);
  }
  return jar;
}

export function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}
