# 2026-07-18 - cf-jwt-enckey-fingerprints

## Summary

Three security fixes from the app-review backlog (Codex, "latent"/"silent" class findings),
landed together on `claude/cf-jwt-enckey-fingerprints`:

- **Item 12** — `middleware.ts`'s Cloudflare Access header trust (`CF_ACCESS_TRUST_EMAIL_HEADER`)
  no longer trusts `cf-access-authenticated-user-email` on its own. The flag now additionally
  requires `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`, and every request must carry a
  `Cf-Access-Jwt-Assertion` that verifies against the team's JWKS
  (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`) with a matching audience, using
  `jose`'s edge-compatible `createRemoteJWKSet`/`jwtVerify`. Any missing config or failed
  verification makes the header IGNORED (fail closed) — never a degraded/partial trust. The flag
  is OFF in production today, so this changes no live behavior; it closes the trap for if/when the
  flag is ever turned on.
- **Item 14** — `src/lib/db-api-keys.ts` no longer silently mints a per-process ephemeral
  `ENCRYPTION_KEY` in production. A new `assertEncryptionKeyConfiguredInProduction()`, called from
  `instrumentation.ts`'s Node-runtime boot hook (mirroring the existing
  `assertSecretsManagerIfRequired()` pattern), throws before any request is served when
  `NODE_ENV === "production"` and `ENCRYPTION_KEY` is missing or not a valid 64-char hex string. Dev
  keeps a deterministic `console.warn` instead of throwing. The ciphertext envelope is now versioned
  (`v1:iv:tag:ciphertext`, was bare `iv:tag:ciphertext`) so a future format/key-rotation change has
  somewhere to go, while `decryptValue` still decrypts every existing un-prefixed row unchanged. A
  new idempotent, audited `migrateLegacyPlaintextCredentials()` sweep re-encrypts any legacy
  PLAINTEXT `user_api_keys`/`connected_accounts` rows in place once a real (non-ephemeral) key is
  confirmed available; it also runs from `instrumentation.ts` on every boot
  (`migrateLegacyPlaintextCredentialsIfKeyConfigured`, gated so it never touches data when only the
  ephemeral fallback key is active).
- **Item 15** — the LLM usage/cost admin surfaces (`/admin/llm-usage`, `/console/usage`) no longer
  ship a masked real-key prefix/suffix (`maskApiKey`: first 8 + last 4 raw chars) to the client. Both
  API routes (`app/api/admin/llm-usage/route.ts`, `app/api/llm-usage/route.ts`) and the shared client
  (`app/admin/llm-usage/llm-usage-client.tsx`) now carry only a label + an irreversible
  `displayKeyFingerprint` (first 8 hex chars of SHA-256(key)), computed server-side in
  `src/lib/llm-usage.ts`'s `describeUsageKey`. This matches the Connections promise that a stored
  key is never displayed again.

## Why

All three are Codex-flagged latent/silent traps rather than exploited-in-prod bugs:

- Item 12: the CF Access flag is off in prod today, but the origin is directly reachable (no
  Cloudflare Tunnel in front), so turning the flag on without this fix would have made
  `cf-access-authenticated-user-email` a full, trivially-spoofable auth bypass — a plain HTTP
  header an attacker fully controls.
- Item 14: a real-money trading app silently minting a throwaway in-memory encryption key means
  every broker credential/OAuth token encrypted during that process's life becomes permanently
  unreadable the moment the process restarts — a slow-motion data-loss bug with no visible symptom
  until the first restart after the key was implicitly (and silently) rotated. Prod already sets
  `ENCRYPTION_KEY` correctly, so the boot guard should never fire there in practice; it's the
  backstop for the day someone forgets or a redeploy drops the env var.
- Item 15: Connections' whole design promise is "we never show you a stored key again." The masked
  8+4-char reveal in the usage/cost admin view quietly broke that promise for anyone who can reach
  `/admin/llm-usage` or `/console/usage`.

## Files

- `middleware.ts` — CF Access JWT verification (`isCfAccessConfigured`, `normalizeCfTeamDomain`,
  `getCfAccessJwks`, `verifyCfAccessAssertion`, rewritten `getCfEmail`, now `async`).
- `.env.example` — documents `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`; corrects the stale
  "deprecated/ignored" comment on `CF_ACCESS_TRUST_EMAIL_HEADER` (the flag is very much still read).
- `test/middleware-auth.test.ts` — new `armCfAccessJwks()` harness (real RSA keypair + mocked
  `fetch` serving the JWKS + `jose` `SignJWT`), replacing the old unsigned `fakeCfAccessAssertion`
  fixture the pre-fix code never actually verified. Rewrote 4 tests that previously encoded the
  vulnerable "header alone is trusted" behavior; added 6 new fail-closed regression tests (no
  assertion header, garbage assertion, wrong-key signature, wrong audience, header/JWT email
  mismatch, team-domain-without-aud).
- `src/lib/db-api-keys.ts` — `isValidEncryptionKeyHex`, `assertEncryptionKeyConfiguredInProduction`,
  `CIPHERTEXT_VERSION_PREFIX`, versioned `encryptValue`/`decryptValue`, `isEncryptedValue`,
  `migrateLegacyPlaintextCredentials`, `migrateLegacyPlaintextCredentialsIfKeyConfigured`; dev/local
  warning path replaces the previously-silent ephemeral-key fallback.
- `src/lib/db.ts` — `hasEncryptedCredentials`'s OAuth-token envelope regex now accepts an optional
  `v1:` prefix (would otherwise have silently stopped detecting newly-encrypted OAuth token rows).
- `src/lib/mcp-oauth.ts` — `encryptionKeyConfigured()` now validates the key (via
  `isValidEncryptionKeyHex`) instead of just checking presence, closing the same "set-but-malformed
  key silently uses the ephemeral fallback" gap for Robinhood OAuth tokens specifically.
- `instrumentation.ts` — calls `assertEncryptionKeyConfiguredInProduction()` (right after the
  existing `assertSecretsManagerIfRequired()`) and `migrateLegacyPlaintextCredentialsIfKeyConfigured()`
  (after the existing env-credential migration calls).
- `test/encryption-key-guard.test.ts` — new file: prod-refusal (env-gated, missing/malformed/valid
  key), versioned-envelope round-trip, legacy-bare-envelope backward compatibility, `isEncryptedValue`,
  and the migration sweep (idempotent, audited, untouched-if-already-encrypted, no-ops on the
  ephemeral key).
- `test/security-oauth-token-encryption.test.ts` — updated the raw-envelope assertion for the new
  `v1:` prefix (was asserting a bare 3-part split).
- `src/lib/llm-usage.ts` — `KeyDescriptor.fingerprint` replaces `last4`/`masked`; new
  `displayKeyFingerprint`; `maskApiKey` removed; `describeUsageKey` returns the fingerprint instead.
- `app/api/admin/llm-usage/route.ts`, `app/api/llm-usage/route.ts` — payload now carries
  `keyFingerprint` instead of `keyLast4`/`keyMasked`.
- `app/admin/llm-usage/llm-usage-client.tsx` — `UsageRow`/`KeyBadge` updated to render
  `#<fingerprint>` instead of a masked raw-key reveal.
- `test/key-resolution-tiering.test.ts` — updated `describeUsageKey` assertions for the new
  fingerprint shape; added an explicit "never contains the raw key" assertion.

## Verification

- `npx vitest run test/middleware-auth.test.ts` — 35 passed.
- `npx vitest run test/encryption-key-guard.test.ts test/security-oauth-token-encryption.test.ts test/key-resolution-tiering.test.ts` — 47 passed.
- `npx vitest run test/persistence-hardening.test.ts test/middleware-auth.test.ts` — 56 passed.
- `npx vitest run test/llm-usage-per-account.test.ts test/llm-cache-usage.test.ts test/usage-model-merge.test.ts test/llm-usage-labels.test.ts` — 44 passed (other LLM-usage suites, confirming no other consumer depended on `maskApiKey`/`keyLast4`/`keyMasked`).
- `npx eslint middleware.ts instrumentation.ts src/lib/db-api-keys.ts src/lib/db.ts src/lib/mcp-oauth.ts src/lib/llm-usage.ts app/api/admin/llm-usage/route.ts app/api/llm-usage/route.ts app/admin/llm-usage/llm-usage-client.tsx test/middleware-auth.test.ts test/encryption-key-guard.test.ts test/security-oauth-token-encryption.test.ts test/key-resolution-tiering.test.ts` — 0 errors, 5 pre-existing warnings (unrelated lines, already grandfathered to `warn`).
- `npx tsc --noEmit` — run against the full project; the shared build box had ~20 concurrent
  `tsc --noEmit` processes from other agents at the time (`load average: 44.87 52.09 59.19`), so the
  full-project run needed to be backgrounded rather than completing within a normal timeout. See the
  Follow-ups note below for how to re-confirm this once the box is quieter.
- No full `npm run build` (per task scope — the four gates above cover the touched surfaces; a full
  build was explicitly out of scope for this task).

## Backward-compatibility proof (existing ciphertexts)

- **Algorithm/key derivation unchanged**: `ALGORITHM = "aes-256-gcm"` and `ENCRYPTION_KEY` (32-byte
  buffer from the hex env var) are untouched — the fix only changes what wraps the ciphertext, not
  how it is produced.
- **`decryptValue` reads oldest-compatible-first**: it strips a `v1:` prefix if present, then splits
  the remainder into exactly 3 parts (iv, authTag, ciphertext) — precisely the pre-existing bare
  `iv:tag:ct` shape every row in production was encrypted as. A bare, un-prefixed row (all of
  today's prod data) hits the exact same 3-part-split → `createDecipheriv` → `setAuthTag` →
  `update`/`final` path as before my change, byte-for-byte, because the `versioned` branch only
  strips a prefix that isn't there (no-op) before falling into the same code. `test/encryption-key-guard.test.ts`'s
  "decryptValue still decrypts a PRE-VERSIONING bare iv:tag:ct envelope under the SAME algorithm/key"
  test hand-rolls that exact legacy shape (bypassing `encryptValue` entirely) and confirms it still
  decrypts correctly.
- **New writes get the `v1:` prefix; nothing rewrites old rows just by reading them**: `encryptValue`
  now prefixes new ciphertext, but `decryptValue` never rewrites a row — a legacy bare-envelope row
  stays bare until either (a) the app updates that credential through its normal write path (which
  calls `encryptValue` and produces a fresh `v1:`-prefixed value), or (b) the new
  `migrateLegacyPlaintextCredentials` sweep runs — and that sweep only touches rows that fail
  `isEncryptedValue` (genuine plaintext), explicitly leaving already-encrypted bare-envelope rows
  alone (proven in `test/encryption-key-guard.test.ts`'s "leaves already-encrypted rows
  byte-for-byte untouched" assertion).
- **`hasEncryptedCredentials` (db.ts) still detects both shapes**: the `connected_accounts` check
  uses a `GLOB '*:*:*'` pattern, which matches a `v1:`-prefixed value the same as a bare one (GLOB
  doesn't anchor total colon count). The OAuth-token-blob check DID need a fix — its regex anchored
  `^[0-9a-f]{24}:...` and would have silently stopped matching new `v1:`-prefixed ciphertext; it now
  accepts an optional `(?:v1:)?` prefix, so the boot guard keeps firing correctly for both old and
  new rows.
- **The owner's real prod `ENCRYPTION_KEY` needs zero action**: nothing about the key itself, its
  format, or its derivation changed — only the ciphertext's outer envelope gained an optional
  prefix that `decryptValue` already knows to strip.

## New environment variables

- `CF_ACCESS_TEAM_DOMAIN` — Cloudflare Access team domain (bare team name or full custom hostname).
  Required alongside `CF_ACCESS_AUD` for `CF_ACCESS_TRUST_EMAIL_HEADER=1` to arm anything. Empty by
  default; no effect until the trust flag is also turned on.
- `CF_ACCESS_AUD` — the protected Access application's Audience (AUD) tag. Same arming requirement
  as above.
- No new variables for items 14/15 — `ENCRYPTION_KEY` already existed; the fix changes how its
  absence/invalidity is handled, not the variable itself.

## Follow-ups

- Re-run `npx tsc --noEmit` once the shared build box is less contended (it was running ~20
  concurrent `tsc` processes from other agents during this session and did not finish within an
  8-minute window); nothing in this diff is expected to introduce type errors (all touched files
  were hand-reviewed and the affected test suites pass), but the gate should still be confirmed
  green before merge per the repo's verify protocol.
- `mcp-oauth.ts`'s Robinhood OAuth token blobs are NOT covered by the new
  `migrateLegacyPlaintextCredentials` sweep (out of scope for this task — that module already has
  its own `migrateLocalRobinhoodToken` and encrypt-on-write path with its own legacy-plaintext
  tolerance). If a future pass wants one unified plaintext-credential sweep across all three stores
  (`user_api_keys`, `connected_accounts`, OAuth token blobs in `settings`), that's a small, separate
  follow-up.
- `CF_ACCESS_TRUST_EMAIL_HEADER` remains OFF in production; this fix is a backstop for if/when it is
  turned on, not a change to current prod auth behavior. If the owner ever wants to actually enable
  Cloudflare Access header trust, `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` must be set at the same
  time or the header will be (correctly) ignored and every request will 401.
