// Boot-time and runtime guards for DB_BOOTSTRAP=live identity fail-closed behavior.
// Edge-safe: no Node-only imports — middleware may import this module.

function isFlagOn(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** True when this process is serving the production live database (Coolify prod boot). */
export function isLiveBootstrap(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DB_BOOTSTRAP?.trim() === "live";
}

/** Whether at least one real upstream identity source is configured. Mirrors middleware.ts isAuthConfigured(). */
export function isAuthIdentitySourceConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AUTH_SECRET?.trim()) return true;
  return (
    isFlagOn(env.CF_ACCESS_TRUST_EMAIL_HEADER) &&
    Boolean(env.CF_ACCESS_TEAM_DOMAIN?.trim()) &&
    Boolean(env.CF_ACCESS_AUD?.trim())
  );
}

/**
 * Refuse to boot under DB_BOOTSTRAP=live when no identity source is configured. A selective env
 * regression (AUTH_SECRET dropped while the app otherwise boots) would otherwise make every anonymous
 * request resolve as the owner via the dev/local fallback.
 */
export function assertAuthSecretConfiguredInLiveBootstrap(env: NodeJS.ProcessEnv = process.env): void {
  if (!isLiveBootstrap(env)) return;
  if (isAuthIdentitySourceConfigured(env)) return;
  throw new Error(
    "AUTH_SECRET is missing in a live production boot (DB_BOOTSTRAP=live) and Cloudflare Access " +
      "trust is not fully armed either. Refusing to boot: without a real identity source configured, " +
      "every request would resolve as the owner via the dev/local fallback. Set AUTH_SECRET (or fully " +
      "configure CF_ACCESS_TRUST_EMAIL_HEADER + CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD) before starting."
  );
}
