// Multi-user identity (Q3). The app derives a per-user id from middleware-supplied email metadata —
// never from a client-supplied hint. Middleware separately forwards identity-source provenance so
// role-sensitive gates can distinguish verified upstream identities from the local fallback.
// See docs/chat-multiuser-learning-design.md §2.
//
// NOTE: this module uses node `crypto` (for `userIdForEmail`) and must only be imported from the Node
// runtime (route handlers, lib), NOT from edge middleware. The email predicates it used to define are
// now in the crypto-free `./admin-emails`, which `middleware.ts` imports directly — so the edge shares
// this file's exact primary/admin allowlist rather than keeping a second copy that could drift.

import { createHash } from "crypto";
import { DEFAULT_PRIMARY_EMAIL, isPrimaryEmail, normalizeEmail, primaryEmails } from "./admin-emails";

/** Back-compatible identity used when auth is unconfigured or an email input is invalid. */
export const DEV_USER_ID = (process.env.DEV_USER_ID || "local").trim();

/** The primary operator's email (module-load snapshot, back-compat export). Their account inherits the
 *  legacy `"local"` dataset, so going multi-user needs no data migration; every other user gets an
 *  isolated id. Prefer `isPrimaryEmail()` for checks — it reads env fresh and honors aliases. */
export const PRIMARY_USER_EMAIL = (process.env.PRIMARY_USER_EMAIL || DEFAULT_PRIMARY_EMAIL).trim().toLowerCase();

function splitEmails(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// `normalizeEmail` / `primaryEmails` / `isPrimaryEmail` now live in the edge-safe `./admin-emails`
// module so `middleware.ts` can share this exact definition instead of keeping its own copy.  The
// re-export keeps `isPrimaryEmail` importable from here for existing callers.
export { isPrimaryEmail };

/**
 * Deterministic, stable app userId for a verified email. The primary user (and any of their configured
 * aliases) keep the legacy `"local"` id (no migration); everyone else gets an opaque `u_<hash>` id. Invalid
 * input falls back to the configured development user id.
 */
export function userIdForEmail(email: string): string {
  const e = normalizeEmail(email);
  if (!e || !e.includes("@")) return DEV_USER_ID;
  if (primaryEmails().has(e)) return "local";
  return "u_" + createHash("sha256").update(e).digest("hex").slice(0, 24);
}

/**
 * Allowlist gate. The primary email and its aliases are always allowed. When `ALLOWED_EMAILS` is unset,
 * non-primary users are denied; Auth.js authenticates identity, while this app still authorizes access.
 */
export function isEmailAllowed(email: string): boolean {
  const e = normalizeEmail(email);
  if (!e || !e.includes("@")) return false;
  if (primaryEmails().has(e)) return true;
  const allowed = splitEmails(process.env.ALLOWED_EMAILS);
  if (allowed.length === 0) return false;
  return allowed.includes(e);
}
