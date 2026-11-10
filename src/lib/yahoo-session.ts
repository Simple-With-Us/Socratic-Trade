import { dataSourceFetch, resolveDataSourceProxy } from "./data-source-fetch";

export interface YahooSessionCreds {
  cookie: string;
  crumb: string;
  expiresAt: number;
}

export const YAHOO_SESSION_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

export const YAHOO_SESSION_HANDSHAKE_TIMEOUT_MS = 8_000;

const YF_CRUMB_TTL_MS = 55 * 60_000;
const YF_CREDS_RETRY_BACKOFF_MS = 500;

type YahooSessionHost = typeof globalThis & {
  __yahooSessionCredsByProxy?: Map<string, YahooSessionCreds>;
};

const sessionHost = globalThis as YahooSessionHost;

function yfCredsByProxy(): Map<string, YahooSessionCreds> {
  return (sessionHost.__yahooSessionCredsByProxy ??= new Map<string, YahooSessionCreds>());
}

function proxyCacheKey(userId?: string): string {
  return resolveDataSourceProxy(userId).proxyUrl ?? "direct";
}

export function invalidateYahooSessionCreds(userId?: string): void {
  yfCredsByProxy().delete(proxyCacheKey(userId));
}

export function clearYahooSessionCredsCache(): void {
  yfCredsByProxy().clear();
}

export function __resetYahooSessionCredsForTests(): void {
  clearYahooSessionCredsCache();
}

/** Resolves `true` after `ms`, or `false` when the caller aborts (no throw). */
export async function yahooSleepOrAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function yahooCombinedAbortSignal(local: AbortSignal, caller?: AbortSignal): AbortSignal {
  if (!caller) return local;
  if (caller.aborted) return caller;
  if (local.aborted) return local;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([local, caller]);
  return local;
}

async function sessionFetch(
  url: string,
  init: RequestInit,
  userId?: string,
  callerSignal?: AbortSignal
): Promise<Response> {
  if (callerSignal?.aborted) {
    throw callerSignal.reason ?? new DOMException("aborted", "AbortError");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YAHOO_SESSION_HANDSHAKE_TIMEOUT_MS);
  const signal = yahooCombinedAbortSignal(controller.signal, callerSignal);
  try {
    return await dataSourceFetch(url, { ...init, signal }, { userId });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCreds(now: number, userId?: string, callerSignal?: AbortSignal): Promise<YahooSessionCreds> {
  if (callerSignal?.aborted) {
    throw callerSignal.reason ?? new DOMException("aborted", "AbortError");
  }
  const cookieRes = await sessionFetch(
    "https://fc.yahoo.com",
    {
      headers: { "user-agent": YAHOO_SESSION_UA },
      redirect: "follow"
    },
    userId,
    callerSignal
  );
  if (callerSignal?.aborted) {
    throw callerSignal.reason ?? new DOMException("aborted", "AbortError");
  }
  const rawCookies: string[] =
    typeof (cookieRes.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (cookieRes.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [cookieRes.headers.get("set-cookie") ?? ""].filter(Boolean);
  const cookie = rawCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");

  const crumbRes = await sessionFetch(
    "https://query1.finance.yahoo.com/v1/test/getcrumb",
    {
      headers: { "user-agent": YAHOO_SESSION_UA, Cookie: cookie, accept: "text/plain" }
    },
    userId,
    callerSignal
  );
  if (!crumbRes.ok) throw new Error(`Yahoo Finance crumb failed: ${crumbRes.status}`);
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.startsWith("{")) throw new Error("Invalid Yahoo Finance crumb");

  const creds: YahooSessionCreds = { cookie, crumb, expiresAt: now + YF_CRUMB_TTL_MS };
  yfCredsByProxy().set(proxyCacheKey(userId), creds);
  return creds;
}

/** Cookie + crumb pair for Yahoo v7/v10 endpoints; keyed by egress proxy. */
export async function getYahooSessionCreds(
  userId?: string,
  callerSignal?: AbortSignal
): Promise<YahooSessionCreds | null> {
  if (callerSignal?.aborted) return null;
  const now = Date.now();
  const cacheKey = proxyCacheKey(userId);
  const cached = yfCredsByProxy().get(cacheKey);
  if (cached && cached.expiresAt > now) return cached;

  try {
    return await fetchCreds(now, userId, callerSignal);
  } catch (error) {
    if (callerSignal?.aborted) return null;
    const slept = await yahooSleepOrAborted(YF_CREDS_RETRY_BACKOFF_MS, callerSignal);
    if (!slept) return null;
    try {
      return await fetchCreds(Date.now(), userId, callerSignal);
    } catch (retryError) {
      if (callerSignal?.aborted) return null;
      throw retryError;
    }
  }
}
