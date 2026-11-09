import { dataSourceFetch, resolveDataSourceProxy } from "./data-source-fetch";

export interface YahooSessionCreds {
  cookie: string;
  crumb: string;
  expiresAt: number;
}

export const YAHOO_SESSION_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

const yfCredsByProxy = new Map<string, YahooSessionCreds>();
const YF_CRUMB_TTL_MS = 55 * 60_000;
const YF_CREDS_RETRY_BACKOFF_MS = 500;

function proxyCacheKey(userId?: string): string {
  return resolveDataSourceProxy(userId).proxyUrl ?? "direct";
}

export function invalidateYahooSessionCreds(userId?: string): void {
  yfCredsByProxy.delete(proxyCacheKey(userId));
}

/** Test-only reset for Yahoo session cache. */
export function clearYahooSessionCredsCache(): void {
  yfCredsByProxy.clear();
}

export function __resetYahooSessionCredsForTests(): void {
  clearYahooSessionCredsCache();
}

async function fetchCreds(now: number, userId?: string): Promise<YahooSessionCreds> {
  const cookieRes = await dataSourceFetch(
    "https://fc.yahoo.com",
    {
      headers: { "user-agent": YAHOO_SESSION_UA },
      redirect: "follow"
    },
    { userId }
  );
  const rawCookies: string[] =
    typeof (cookieRes.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (cookieRes.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [cookieRes.headers.get("set-cookie") ?? ""].filter(Boolean);
  const cookie = rawCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");

  const crumbRes = await dataSourceFetch(
    "https://query1.finance.yahoo.com/v1/test/getcrumb",
    {
      headers: { "user-agent": YAHOO_SESSION_UA, Cookie: cookie, accept: "text/plain" }
    },
    { userId }
  );
  if (!crumbRes.ok) throw new Error(`Yahoo Finance crumb failed: ${crumbRes.status}`);
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.startsWith("{")) throw new Error("Invalid Yahoo Finance crumb");

  const creds: YahooSessionCreds = { cookie, crumb, expiresAt: now + YF_CRUMB_TTL_MS };
  yfCredsByProxy.set(proxyCacheKey(userId), creds);
  return creds;
}

/** Cookie + crumb pair for Yahoo v7/v10 endpoints; keyed by egress proxy. */
export async function getYahooSessionCreds(userId?: string): Promise<YahooSessionCreds> {
  const now = Date.now();
  const cacheKey = proxyCacheKey(userId);
  const cached = yfCredsByProxy.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached;

  try {
    return await fetchCreds(now, userId);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, YF_CREDS_RETRY_BACKOFF_MS));
    return await fetchCreds(Date.now(), userId);
  }
}
