export const PUBLIC_SITE_FALLBACK_ORIGIN = "https://socratictrade.com";
const LEGACY_PUBLIC_HOSTS = new Set(["trading.jays.services"]);

export function resolvePublicAppOrigin(request: Request): string {
  const configuredPublicOrigin =
    normalizeOrigin(process.env.NEXT_PUBLIC_SITE_URL) ||
    normalizeOrigin(process.env.AUTH_URL) ||
    normalizeOrigin(process.env.NEXTAUTH_URL);
  if (configuredPublicOrigin && (process.env.NODE_ENV !== "production" || !isLoopbackUrl(configuredPublicOrigin))) {
    return configuredPublicOrigin;
  }

  // Proxy forwarding headers and Host are client-influenceable at a directly reachable origin.
  // With no configured canonical origin, use the fixed production hostname. Local development is
  // the only exception, and derives solely from Request.url (never X-Forwarded-Host).
  const requestOrigin = new URL(request.url).origin;
  if (process.env.NODE_ENV !== "production" && isLoopbackUrl(requestOrigin)) return requestOrigin;
  return PUBLIC_SITE_FALLBACK_ORIGIN;
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
