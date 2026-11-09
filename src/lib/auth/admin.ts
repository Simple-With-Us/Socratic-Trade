// Admin-role gate for admin/dev-only routes (Node runtime).
//
// The app has no first-class "role" concept yet, so admin is an EMAIL ALLOWLIST: `ADMIN_USER_EMAILS`
// (comma-separated). Middleware forwards both the email and its identity-source provenance. Email-based
// admin authorization accepts only Cloudflare Access or Auth.js session provenance, never the synthetic
// auth-unconfigured local fallback or a client-supplied identity.
//
// Default DENY: when `ADMIN_USER_EMAILS` is unset/empty, no non-primary email qualifies as admin. The
// primary operator is an admin only when middleware marks the identity as verified.
//
// Back-compat: the existing admin routes also accept a static `ADMIN_REINDEX_TOKEN` via the
// `x-admin-token` header. There is no environment- or hostname-based unauthenticated bypass.

import crypto from "crypto";
import { AUTHENTICATED_EMAIL_HEADER } from "../request-user";
import { isAdminEmail } from "./admin-emails";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  isVerifiedIdentitySource
} from "./strip-identity";

// `isAdminEmail` is defined in the edge-safe `./admin-emails` module so that `middleware.ts` (which
// cannot import this file — it pulls in node `crypto`) gates the /admin PAGE tree on the exact same
// allowlist this gate uses for the /api/admin/* routes.  Re-exported here so existing importers of
// `@/lib/auth/admin` are unchanged.
export { isAdminEmail };

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

export interface RequireAdminOptions {
  /** Allow the legacy `x-admin-token` === `ADMIN_REINDEX_TOKEN` bypass. Default true. */
  allowToken?: boolean;
  /**
   * When true, a verified admin EMAIL alone is NOT sufficient in production — the `x-admin-token`
   * must also match. Restores the legacy per-route production token gate for cost/side-effecting
   * operator routes (the SEC reindex backfills). Rationale: when app auth is unconfigured,
   * `middleware.ts` injects the primary-operator email for EVERY request as a dev/local fallback,
   * which would otherwise satisfy the email path here and let an unauthenticated caller trigger a
   * paid Voyage backfill in a production misconfiguration. The provenance check below now denies
   * that fallback independently; this option preserves the stronger token-only production policy.
   */
  requireTokenInProd?: boolean;
}

export interface AdminCheck {
  ok: boolean;
  /** Machine reason for logging/tests. */
  reason: string;
  /** The verified admin email when `ok` via the allowlist (null for the token path). */
  email: string | null;
}

/**
 * Decide whether a request may access an admin/dev route. Order of acceptance:
 *   1. middleware-verified admin email (ADMIN_USER_EMAILS allowlist or primary operator),
 *   2. legacy `x-admin-token` matching `ADMIN_REINDEX_TOKEN` (if `allowToken`).
 * Otherwise denied → callers should return 403.
 */
export function checkAdmin(request: Request, options: RequireAdminOptions = {}): AdminCheck {
  const { allowToken = true, requireTokenInProd = false } = options;
  const inProd = process.env.NODE_ENV === "production";

  // Constant-time compare so a wrong token can't be recovered byte-by-byte via response timing.
  // timingSafeEqualStr denies when either side is empty/undefined (no configured token → no match).
  const tokenMatches =
    allowToken && timingSafeEqualStr(process.env.ADMIN_REINDEX_TOKEN, request.headers.get("x-admin-token"));

  // Hard token gate for cost/side-effecting routes in production: only a real token match grants.
  if (requireTokenInProd && inProd) {
    if (tokenMatches) return { ok: true, reason: "admin-token", email: null };
    return { ok: false, reason: "forbidden-token-required", email: null };
  }

  const email = request.headers.get(AUTHENTICATED_EMAIL_HEADER);
  const identitySource = request.headers.get(AUTHENTICATED_IDENTITY_SOURCE_HEADER);
  if (isVerifiedIdentitySource(identitySource) && isAdminEmail(email)) {
    return { ok: true, reason: "admin-email", email: (email || "").trim().toLowerCase() };
  }

  if (tokenMatches) return { ok: true, reason: "admin-token", email: null };

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
