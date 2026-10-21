/**
 * The public host map for the site — one source of truth for both the edge
 * middleware and the apex route.
 *
 * The host sets used to be written out twice (middleware.ts and app/page.tsx).
 * A change to one copy could silently drift from the other, and the drift
 * would not show up in a type check: both copies compiled, they just disagreed
 * about which host was the public one.  This module holds the sets once and
 * exposes predicates, so a caller cannot mutate the shared state.
 *
 * Note that this module is imported by the edge middleware, so it must stay
 * free of Node-only APIs.
 */

/** The public marketing hosts. A visitor who opens the canonical domain lands on
 *  the /welcome product page, not on the operator console. 2026-10-19 (owner):
 *  "The /welcome page should be where viewers of the main domain go to
 *  initially." */
const MARKETING_HOSTS = [
  "socratictrade.com",
  "www.socratictrade.com",
  "socratic.trade",
  "www.socratic.trade"
] as const;

/** The alt domain forwards to the canonical one. socratic.trade's DNS already
 *  CNAMEs to socratictrade.com, so both hosts reach the same Next.js origin and
 *  the redirect has to happen here in the app. */
const ALT_DOMAIN_HOSTS = ["socratic.trade", "www.socratic.trade"] as const;

/** The canonical domain every public host forwards to. */
export const CANONICAL_HOST = "socratictrade.com";

/** True when `host` is one of the public marketing hosts. */
export function isMarketingHost(host: string): boolean {
  return (MARKETING_HOSTS as readonly string[]).includes(host);
}

/** True when `host` is the alt domain that forwards to the canonical one. */
export function isAltDomainHost(host: string): boolean {
  return (ALT_DOMAIN_HOSTS as readonly string[]).includes(host);
}
