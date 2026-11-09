// Human copy for admin data-probe failures (client-side fetch error presentation).
//
// The admin API layer (src/lib/auth/admin.ts: requireAdmin/checkAdmin) can genuinely 403 a caller
// whose identity isn't a verified admin — including the dev-fallback identity in local dev, which
// middleware.ts trusts for ordinary routes but the admin gate does not, since isVerifiedIdentitySource
// (src/lib/auth/strip-identity.ts) excludes the local-fallback source. That's real, intentional auth
// behavior and this file does not change who gets in. It only controls how a probe failure already
// returned by the API is PRESENTED to the operator: plain remediation copy instead of a bare
// "HTTP 403", with the raw status kept around for a title/tooltip so it isn't lost for debugging.

export type ProbeErrorAudience = "operator" | "generic";

export interface ProbeErrorDescription {
  /** Human-readable copy for a banner or inline notice body. */
  message: string;
  /** Compact human copy for a chip/badge where space is tight. */
  shortMessage: string;
  /** Raw "HTTP 403"-style label, kept for a title/tooltip — never dropped, just not the headline. */
  rawLabel: string;
}

/**
 * Format a failed-fetch HTTP status for display. `audience` picks the wording: "operator" (the
 * default) for admin-only routes gated by `requireAdmin` — most admin data probes — vs "generic"
 * for routes any signed-in user can call (e.g. the console's own usage page reusing an admin
 * component), where a 403 doesn't mean "you need operator access."
 */
export function describeProbeStatus(status: number, audience: ProbeErrorAudience = "operator"): ProbeErrorDescription {
  const rawLabel = `HTTP ${status}`;
  if (status === 403) {
    return {
      rawLabel,
      message:
        audience === "operator"
          ? "Operator access required — this data needs an admin API identity the current session doesn't have."
          : "Access denied for this account.",
      shortMessage: audience === "operator" ? "Operator access required" : "Access denied"
    };
  }
  if (status === 401) {
    return { rawLabel, message: "Not signed in — sign in again to load this data.", shortMessage: "Not signed in" };
  }
  if (status === 404) {
    return { rawLabel, message: "This data source isn't available right now.", shortMessage: "Not available" };
  }
  if (status >= 500) {
    return {
      rawLabel,
      message: "The server had a problem loading this data.  Try refreshing.",
      shortMessage: "Server error"
    };
  }
  return { rawLabel, message: `Couldn't load this data (${rawLabel}).`, shortMessage: `Failed (${rawLabel})` };
}

/** Description for a fetch that never got an HTTP response at all (network failure, CORS, etc.). */
export function describeProbeNetworkError(): ProbeErrorDescription {
  return {
    rawLabel: "network error",
    message: "Couldn't reach the server to load this data.  Check your connection and try again.",
    shortMessage: "Request failed"
  };
}
