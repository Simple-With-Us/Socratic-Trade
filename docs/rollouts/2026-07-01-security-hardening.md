# 2026-07-01 — Security hardening (Chat G, items G1–G4)

## Summary

Closed four residual (non-P0) security gaps from the 2026-07-01 audit work-split
(`docs/reviews/2026-07-01-audit-work-split.md`, Chat G, items 1–4):

- **G1** — Rate-limited `/api/chat` (POST) and `/api/scan` (GET) per user.
- **G2** — Encrypted the Robinhood MCP OAuth token secrets at rest.
- **G3** — Made the admin-token comparison constant-time and migrated the
  `reindex-10k` route onto the shared `requireAdmin` gate; documented the
  `allowNonProd` default-true risk.
- **G4** — Added always-on `X-Frame-Options` / `Referrer-Policy` response headers
  and a default-OFF, report-only-by-default CSP in `middleware.ts`.

Every behavior change sits behind a conservative/default-safe posture so nothing
breaks the running dashboard (rate limits are generous per-user bursts; CSP is
off unless explicitly enabled and then report-only).

## Why

The audit found `/api/chat` and `/api/scan` resolved a user but never called the
existing `enforceRateLimit`; Robinhood OAuth tokens were persisted as plaintext
JSON; admin-token checks used `===` (timing side-channel + length leak); and no
CSP/X-Frame-Options/Referrer-Policy existed anywhere.

## What changed (files + how)

### G1 — Rate limit chat & scan
- `src/lib/rate-limit.ts` — added two entries to `RATE_LIMITS`:
  - `chat: { limit: 30, windowMs: 60_000 }`
  - `scan: { limit: 30, windowMs: 60_000 }`
- `app/api/chat/route.ts` — `enforceRateLimit(userId, "chat", RATE_LIMITS.chat)`
  immediately after `resolveRequestUserId`, before the message/LLM-credential
  gates. Over-limit → 429 with `Retry-After` before any LLM spend.
- `app/api/scan/route.ts` — `enforceRateLimit(userId, "scan", RATE_LIMITS.scan)`
  right after `resolveRequestUserId`, before `getPolicy`/`scanMarket`. Over-limit
  → 429 before any DB/provider fan-out.

### G2 — Encrypt Robinhood OAuth tokens at rest
- `src/lib/db-api-keys.ts` — **exported** the previously module-private
  `encryptValue` / `decryptValue` (AES-256-GCM, `iv:tag:ct` hex envelope, keyed by
  `ENCRYPTION_KEY`). No new helper module was added — the existing field
  encryption is reused verbatim, including its legacy-plaintext fallback (the
  3-part split check in `decryptValue`).
- `src/lib/mcp-oauth.ts` — imports `encryptValue`/`decryptValue` from `./db`
  (re-exported via the `db` barrel's `export * from "./db-api-keys"`). Added
  `encryptStoredTokens` / `decryptStoredTokens` that run ONLY the secret fields
  (`accessToken`, `refreshToken`) through the cipher; `setMcpOAuthTokens` encrypts
  on write, `getStoredMcpOAuthTokens` decrypts on read. Non-secret metadata
  (`tokenType`/`scope`/`expiresAt`) stays plaintext. Legacy plaintext rows still
  load because `decryptValue` returns non-envelope values unchanged.

### G3 — Constant-time admin compare + allowNonProd doc
- `src/lib/auth/admin.ts` — added exported `timingSafeEqualStr(a, b)` using
  `crypto.timingSafeEqual` over equal-length buffers; denies (returns false)
  without calling `timingSafeEqual` when either side is empty/undefined or lengths
  differ (guards the length-leak and the throw-on-unequal-length). `checkAdmin`
  now compares `x-admin-token` via `timingSafeEqualStr` instead of `===`. Expanded
  the `allowNonProd` JSDoc to document the risk (non-"production" `NODE_ENV` grants
  open access) while keeping the default `true` for dev/ops ergonomics.
- `app/api/admin/reindex-10k/route.ts` — removed its local `authorized()` helper
  (which used `===`) and migrated both `GET`/`POST` to the shared `requireAdmin`
  gate. `reindex-8k` already used `requireAdmin`, so it now inherits the
  constant-time compare automatically.

### G4 — Security response headers
- `middleware.ts` — added exported `withSecurityHeaders(res)` plus `isFlagOn` /
  `isFlagExplicitlyOff` / `cspPolicy` helpers. Wrapped EVERY returned response
  (public-path, CSRF 403, allow/forbid/unauthorized, redirects, forwarded next)
  in `withSecurityHeaders`. Always sets `X-Frame-Options: DENY` and
  `Referrer-Policy: strict-origin-when-cross-origin`. CSP is emitted ONLY when
  `CSP_ENABLED` is truthy, and defaults to `Content-Security-Policy-Report-Only`
  unless `CSP_REPORT_ONLY` is explicitly off (then enforcing). `CSP_POLICY`
  overrides the built-in conservative starter policy.

### New env flags introduced
- `CSP_ENABLED` (default off) — turn CSP header emission on.
- `CSP_REPORT_ONLY` (default report-only when CSP enabled) — set falsy to enforce.
- `CSP_POLICY` (optional) — override the built-in starter directive string.

### New tests (all vitest, temp SQLite per run where DB is touched)
- `test/security-route-rate-limit.test.ts` — chat & scan 429 + Retry-After, per-user isolation.
- `test/security-oauth-token-encryption.test.ts` — encrypted-at-rest round-trip, raw row not plaintext, legacy plaintext fallback, access-only token.
- `test/security-admin-timing-safe.test.ts` — `timingSafeEqualStr` match/mismatch/empty; `checkAdmin` token path; production default-deny; reindex-10k/8k route gate.
- `test/security-headers.test.ts` — header presence, CSP default-off, report-only default, enforcing-only-when-explicit, custom policy, headers on 401/403.

## Verification

The full vitest quartet could NOT be run in this cloud worktree: `node_modules`
was partially corrupted and `npm install` fails on the auth-gated private
dependency `@jaywedgeworth22/congress-trading-shared` (GitHub Packages 401) — so
`vitest` itself is not resolvable here. The orchestrator runs the final
tsc/lint/test/build quartet.

To compensate, the load-bearing pure logic of each item was validated with
standalone Node scripts (all PASS):
- Timing-safe compare: equal match, same-length mismatch, length-mismatch (no
  throw), empty/undefined/null all deny.
- Encryption: secret fields absent from the serialized blob, access+refresh
  round-trip, metadata preserved, legacy plaintext still decrypts, access-only OK.
- Security headers: X-Frame-Options/Referrer-Policy always set, CSP off by
  default, report-only when enabled, enforcing only when report-only explicitly
  off.

The four new `test/security-*.test.ts` files mirror existing conventions
(`test/rate-limit.test.ts`, `test/mcp-oauth.test.ts`, `test/admin-gate.test.ts`,
`test/middleware-auth.test.ts`) and should pass once run in an environment with a
complete install.

## Follow-ups / risks

- **Run the four new test files** in a complete environment (orchestrator's verify
  step) — they were authored but not executed here due to the missing install.
- `allowNonProd` default stays `true` by design (documented). A future hardening
  PR could flip security-sensitive admin actions to `allowNonProd: false`.
- CSP is intentionally inert until `CSP_ENABLED` is set; the operator should turn
  it on in report-only, collect telemetry, then tighten `CSP_POLICY` before
  enforcing. The starter policy allows `unsafe-inline`/`unsafe-eval` because Next.js
  ships inline bootstrap scripts.
- Items G5–G10 of Chat G (kill-switch/correlation verification, money-path test,
  token-budget ceiling, embedding cache, Litestream restore, observability) are
  owned by sibling agents / out of this file-scope.
