// Helpers for the native iOS GET OAuth initiator (app/api/mobile/auth-start).
// Kept out of the route file so tests can import them (Next route modules may
// only export handlers/config).

import { PUBLIC_SITE_FALLBACK_ORIGIN } from "./public-origin";

/** The one public origin this app serves (MobileAPIClient.productionBaseURL). */
export const CANONICAL_ORIGIN = PUBLIC_SITE_FALLBACK_ORIGIN;

/** Clamp the post-login destination to a same-origin path so the initiator can
 *  never be used as an open redirector.  Accepts relative paths and absolute
 *  URLs on the resolved public origin or the canonical origin.
 *
 *  `origin` MUST come from `resolvePublicAppOrigin()` (src/lib/public-origin.ts) —
 *  never from `request.url` and never from `X-Forwarded-Host`:
 *
 *  - Inside the Coolify container `request.url` carries the INTERNAL origin
 *    (localhost:3000 class).  Clamping against it rejected every legitimate
 *    absolute callbackUrl and collapsed the mobile handoff to "/", which left the
 *    ASWebAuthenticationSession sheet on the signed-in website instead of firing
 *    the socratictrade:// return (owner-reported 2026-08-27).
 *  - Forwarded headers are client-influenceable at a directly reachable origin,
 *    so deriving the origin from them would let an attacker aim this public
 *    route's fallback redirect at their own host.
 */
export function sameOriginCallback(raw: string | null, origin: string): string {
  if (!raw) return "/";
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin && url.origin !== CANONICAL_ORIGIN) return "/";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}
