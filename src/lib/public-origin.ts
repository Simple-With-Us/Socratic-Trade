export const PUBLIC_SITE_FALLBACK_ORIGIN = "https://socratictrade.com";
const LEGACY_PUBLIC_HOSTS = new Set(["trading.jays.services"]);

export function resolvePublicAppOrigin(request: Request): string {
  const requestOrigin = resolveRequestOrigin(request);
  if (!isLoopbackUrl(requestOrigin)) return requestOrigin;

  const configuredPublicOrigin =
    normalizeOrigin(process.env.NEXT_PUBLIC_SITE_URL) ||
    normalizeOrigin(process.env.AUTH_URL) ||
    normalizeOrigin(process.env.NEXTAUTH_URL);
  if (configuredPublicOrigin && !isLoopbackUrl(configuredPublicOrigin)) return configuredPublicOrigin;

  if (process.env.NODE_ENV === "production") return PUBLIC_SITE_FALLBACK_ORIGIN;
  return requestOrigin;
}

function resolveRequestOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedHost = firstForwardedValue(request.headers.get("x-forwarded-host"));
  const host = forwardedHost || firstForwardedValue(request.headers.get("host")) || url.host;
  const forwardedProto = firstForwardedValue(request.headers.get("x-forwarded-proto"));
  const protocol = forwardedProto || (isLoopbackHost(host) ? url.protocol.replace(/:$/, "") || "http" : "https");
  return normalizeOrigin(`${protocol}://${host}`) || url.origin;
}

function firstForwardedValue(value: string | null): string | undefined {
  return value
    ?.split(",")[0]
    ?.trim()
    .replace(/\/+$/, "");
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(host: string): boolean {
  let normalized = host.trim().toLowerCase();
  if (normalized.startsWith("[")) {
    const end = normalized.indexOf("]");
    if (end >= 0) normalized = normalized.slice(1, end);
  } else if (normalized.includes(":") && !normalized.includes("::")) {
    normalized = normalized.split(":")[0];
  }
  return normalized === "localhost" || normalized === "0.0.0.0" || normalized === "::1" || normalized.startsWith("127.");
}

export function isLegacyTradingOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return LEGACY_PUBLIC_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function canonicalizeLegacyTradingOrigin(value: string | undefined): string | undefined {
  if (!value) return value;
  return isLegacyTradingOrigin(value) ? PUBLIC_SITE_FALLBACK_ORIGIN : value;
}

export function canonicalizeLegacyAuthEnv(env: Record<string, string | undefined>): void {
  const canonicalOrigin = canonicalizeLegacyTradingOrigin(env.NEXT_PUBLIC_SITE_URL) ?? PUBLIC_SITE_FALLBACK_ORIGIN;
  for (const key of ["AUTH_URL", "NEXTAUTH_URL"] as const) {
    if (isLegacyTradingOrigin(env[key])) env[key] = canonicalOrigin;
  }
}
