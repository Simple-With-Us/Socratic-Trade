// Edge-safe (crypto-free) email allowlists shared by the Node admin gate and the edge middleware.
//
// This module exists so that "who is an admin?" has exactly ONE definition. `src/lib/auth/admin.ts`
// (Node runtime, route handlers) and `middleware.ts` (edge runtime, the /admin page tree) both answer
// that question, and before this split they could not share code: `src/lib/auth/identity.ts` imports
// node `crypto` for `userIdForEmail`, so the edge could not import it and would have needed its own
// copy of the predicate.  A duplicated security predicate drifts; a shared one cannot.
//
// Nothing here reads a request or a header — these are pure env-backed predicates.  Deciding whether
// a request's identity may be TRUSTED (provenance, tokens) stays in `admin.ts` / `middleware.ts`.
//
// Every lookup reads `process.env` at call time rather than at module load, so deployment config and
// test `vi.stubEnv` calls take effect without a module reload.

/** Default primary email when PRIMARY_USER_EMAIL is unset. */
export const DEFAULT_PRIMARY_EMAIL = "mail@jays.services";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function splitEmails(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Every email that maps to the PRIMARY operator's single `"local"` account: `PRIMARY_USER_EMAIL` plus
 * any `PRIMARY_USER_EMAIL_ALIASES` (comma-separated).  All of these share ONE identity and ONE
 * dataset, so the owner can sign in with any of their addresses and land on the same data.
 */
export function primaryEmails(): Set<string> {
  const primary = normalizeEmail(process.env.PRIMARY_USER_EMAIL || DEFAULT_PRIMARY_EMAIL);
  return new Set([primary, ...splitEmails(process.env.PRIMARY_USER_EMAIL_ALIASES)]);
}

export function isPrimaryEmail(email: string): boolean {
  return primaryEmails().has(normalizeEmail(email));
}

/** The configured admin allowlist (`ADMIN_USER_EMAILS`), normalized. Empty means "primary only". */
export function adminEmails(): string[] {
  return splitEmails(process.env.ADMIN_USER_EMAILS);
}

/**
 * True if `email` is configured as an admin (or is the primary operator, including any primary
 * aliases).  Default DENY: with `ADMIN_USER_EMAILS` unset/empty, no non-primary email qualifies.
 *
 * This is an identity predicate only.  It says nothing about whether the caller PROVED that identity
 * — callers must separately require a verified identity source (see `isVerifiedIdentitySource`).
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  const e = normalizeEmail(email || "");
  if (!e || !e.includes("@")) return false;
  if (primaryEmails().has(e)) return true;
  return adminEmails().includes(e);
}
