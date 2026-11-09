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
  if (handoffNonce) return true;
  if (clientDeclaresSessionHardening(request)) return true;
  return false;
}

export function mobileAppleSignInIsStrict(request: Request, nonce: string): boolean {
  if (nonce) return true;
  if (clientDeclaresSessionHardening(request)) return true;
  return false;
}
