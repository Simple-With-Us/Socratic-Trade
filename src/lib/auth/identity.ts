// Multi-user identity (Q3). The app derives a per-user id from a VERIFIED email — never from a
// client-supplied hint. In production, `middleware.ts` verifies the Auth.js session at the edge
// and forwards a trusted `x-authenticated-user-email` header that this module maps to a stable userId.
// See docs/chat-multiuser-learning-design.md §2.
//
// NOTE: this module uses node `crypto` and must only be imported from the Node runtime (route handlers,
// lib), NOT from edge middleware. `middleware.ts` keeps its own crypto-free allowlist check.

import { createHash } from "crypto";

/** Dev/test fallback identity, used only when NOT in production (middleware 401s unauth prod requests). */
export const DEV_USER_ID = (process.env.DEV_USER_ID || "local").trim();

/** Default primary email when PRIMARY_USER_EMAIL is unset. */
const DEFAULT_PRIMARY_EMAIL = "mail@jays.services";

/** The primary operator's email (module-load snapshot, back-compat export). Their account inherits the
 *  legacy `"local"` dataset, so going multi-user needs no data migration; every other user gets an
 *  isolated id. Prefer `isPrimaryEmail()` for checks — it reads env fresh and honors aliases. */
export const PRIMARY_USER_EMAIL = (process.env.PRIMARY_USER_EMAIL || DEFAULT_PRIMARY_EMAIL).trim().toLowerCase();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function splitEmails(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Every email that maps to the PRIMARY operator's single `"local"` account: `PRIMARY_USER_EMAIL` plus any
 * `PRIMARY_USER_EMAIL_ALIASES` (comma-separated). All of these share ONE identity and ONE dataset, so the
 * owner can sign in with any of their addresses (e.g. a Gmail and a custom-domain email) and land on the
 * same data. Read at call time so deployment config (and tests via `vi.stubEnv`) take effect without reload.
 */
function primaryEmails(): Set<string> {
  const primary = normalizeEmail(process.env.PRIMARY_USER_EMAIL || DEFAULT_PRIMARY_EMAIL);
  return new Set([primary, ...splitEmails(process.env.PRIMARY_USER_EMAIL_ALIASES)]);
}

export function isPrimaryEmail(email: string): boolean {
  return primaryEmails().has(normalizeEmail(email));
}

/**
 * Deterministic, stable app userId for a verified email. The primary user (and any of their configured
 * aliases) keep the legacy `"local"` id (no migration); everyone else gets an opaque `u_<hash>` id. Invalid
 * input falls back to the dev user (only reachable in non-production — see middleware).
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
