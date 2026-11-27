/** Set by iOS builds that implement handoff-prepare + Apple server nonce (ST-2599 hardening). */
export const MOBILE_SESSION_HARDENING_HEADER = "x-socratic-mobile-session-hardening";

export const LEGACY_MOBILE_HANDOFF_NONCE = "__legacy_compat__";
export const LEGACY_MOBILE_SESSION_ID = "__legacy_compat__";

export function clientDeclaresSessionHardening(request: Request): boolean {
  return request.headers.get(MOBILE_SESSION_HARDENING_HEADER)?.trim() === "1";
}

export function logMobileSessionHardeningCompat(route: string, detail: string): void {
  console.warn(
    `[mobile-session-hardening] legacy compat path on ${route}: ${detail}`,
  );
}

export function mobileOAuthHandoffIsStrict(request: Request, handoffNonce: string): boolean {
  if (handoffNonce && handoffNonce !== LEGACY_MOBILE_HANDOFF_NONCE) return true;
  if (clientDeclaresSessionHardening(request)) return true;
  return false;
}

/** Audit kind recorded once per ACCEPTED legacy (non-strict) Apple sign-in
 *  (ST-4656), so legacy-build usage is countable from audit_events before an
 *  owner-chosen sunset makes the nonce mandatory. Receipts only - this name
 *  gates nothing. */
export const LEGACY_APPLE_AUTH_AUDIT_KIND = "mobile_apple_legacy_auth_accepted";

export function mobileAppleSignInIsStrict(request: Request, nonce: string): boolean {
  if (nonce) return true;
  if (clientDeclaresSessionHardening(request)) return true;
  return false;
}
