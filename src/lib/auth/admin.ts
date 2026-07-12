// Admin-role gate for admin/dev-only routes (Node runtime).
//
// The app has no first-class "role" concept yet, so admin is an EMAIL ALLOWLIST: `ADMIN_USER_EMAILS`
// (comma-separated). Identity is the trusted `x-authenticated-user-email` header that `middleware.ts` sets
// after verifying the upstream login — we never trust a client-supplied identity here (same rule as
// `resolveRequestUserId`).
//
// Default DENY: when `ADMIN_USER_EMAILS` is unset/empty, no email qualifies as admin. The primary operator
// is always admin (they own the deployment) so a misconfigured allowlist can't lock the owner out.
//
// Back-compat: the existing admin routes also accept a static `ADMIN_REINDEX_TOKEN` via the `x-admin-token`
// header and run open outside production. `requireAdmin` composes WITH that: pass `allowToken`/`allowNonProd`
// (both default true) so the email allowlist is an ADDITIONAL way in, not a regression of the prior gate.

import crypto from "crypto";
import { AUTHENTICATED_EMAIL_HEADER } from "../request-user";
import { isPrimaryEmail } from "./identity";

/**
 * Constant-time string equality for secret comparison (admin tokens). Guards against a timing
 * side-channel that a naive `===` leaks. Denies (returns false) without ever calling
 * `crypto.timingSafeEqual` on mismatched-length buffers — that call THROWS on unequal lengths, and
 * comparing length first would itself leak length; instead an empty/undefined side or any length
 * mismatch short-circuits to `false`. Both inputs are required and non-empty to match.
 */
export function timingSafeEqualStr(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function adminEmails(): string[] {
  return (process.env.ADMIN_USER_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** True if `email` is configured as an admin (or is the primary operator, including any primary aliases). */
export function isAdminEmail(email: string | null | undefined): boolean {
  const e = (email || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return false;
  if (isPrimaryEmail(e)) return true; // primary operator + PRIMARY_USER_EMAIL_ALIASES
  return adminEmails().includes(e);
}

export interface RequireAdminOptions {
  /** Allow the legacy `x-admin-token` === `ADMIN_REINDEX_TOKEN` bypass. Default true. */
  allowToken?: boolean;
  /**
   * Allow non-production to run open (preserves existing dev/ops ergonomics). Default true.
   *
   * RISK: with the default `true`, any environment where `NODE_ENV !== "production"` grants admin
   * access to EVERY caller regardless of email allowlist or token. That is intentional for local
   * dev/test ergonomics, but it means an admin route deployed with a non-"production" NODE_ENV (a
   * misconfiguration) is wide open. The edge auth gate (middleware.ts) does NOT rely on NODE_ENV for
   * exactly this reason. In production the value is "production", so this branch is inert; callers that
   * want a hard gate even in non-prod (e.g. a security-sensitive admin action) should pass
   * `allowNonProd: false`. Default kept `true` to avoid breaking the running dashboard's dev/ops flows.
   */
  allowNonProd?: boolean;
  /**
   * When true, a verified admin EMAIL alone is NOT sufficient in production — the `x-admin-token`
   * must also match. Restores the legacy per-route production token gate for cost/side-effecting
   * operator routes (the SEC reindex backfills). Rationale: when app auth is unconfigured,
   * `middleware.ts` injects the primary-operator email for EVERY request as a dev/local fallback,
   * which would otherwise satisfy the email path here and let an unauthenticated caller trigger a
   * paid Voyage backfill in a production misconfiguration. Non-production still honors `allowNonProd`.
   */
  requireTokenInProd?: boolean;
}

export interface AdminCheck {
  ok: boolean;
  /** Machine reason for logging/tests. */
  reason: string;
  /** The verified admin email when `ok` via the allowlist (null for token/non-prod paths). */
  email: string | null;
}

/**
 * Decide whether a request may access an admin/dev route. Order of acceptance:
 *   1. verified admin email (ADMIN_USER_EMAILS allowlist or primary operator),
 *   2. legacy `x-admin-token` matching `ADMIN_REINDEX_TOKEN` (if `allowToken`),
 *   3. non-production (if `allowNonProd`).
 * Otherwise denied → callers should return 403.
 */
export function checkAdmin(request: Request, options: RequireAdminOptions = {}): AdminCheck {
  const { allowToken = true, allowNonProd = true, requireTokenInProd = false } = options;
  const inProd = process.env.NODE_ENV === "production";

  // Constant-time compare so a wrong token can't be recovered byte-by-byte via response timing.
  // timingSafeEqualStr denies when either side is empty/undefined (no configured token → no match).
  const tokenMatches =
    allowToken && timingSafeEqualStr(process.env.ADMIN_REINDEX_TOKEN, request.headers.get("x-admin-token"));

  // Hard token gate for cost/side-effecting routes in production: a synthetic/injected admin email
  // (app auth unconfigured) or the non-prod bypass must NOT grant — only a real token match does.
  if (requireTokenInProd && inProd) {
    if (tokenMatches) return { ok: true, reason: "admin-token", email: null };
    return { ok: false, reason: "forbidden-token-required", email: null };
  }

  const email = request.headers.get(AUTHENTICATED_EMAIL_HEADER);
  if (isAdminEmail(email)) return { ok: true, reason: "admin-email", email: (email || "").trim().toLowerCase() };

  if (tokenMatches) return { ok: true, reason: "admin-token", email: null };

  if (allowNonProd && !inProd) {
    return { ok: true, reason: "non-prod", email: null };
  }

  return { ok: false, reason: "forbidden", email: null };
}

/**
 * Route-handler guard: returns a ready-to-send 403 `Response` when the caller is not an admin, or `null`
 * to proceed. Mirrors the shape the existing admin routes already return.
 */
export function requireAdmin(request: Request, options: RequireAdminOptions = {}): Response | null {
  const result = checkAdmin(request, options);
  if (result.ok) return null;
  return new Response(JSON.stringify({ ok: false, error: "Forbidden: admin access required." }), {
    status: 403,
    headers: { "content-type": "application/json" }
  });
}
