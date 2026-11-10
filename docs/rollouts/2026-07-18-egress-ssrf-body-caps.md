# 2026-07-18 - egress-ssrf-body-caps

## Summary

Two security hardening items (Codex app-review backlog #11 and #13):

- **Item 11 (SSRF / credential exfiltration):** built one shared egress-guard utility
  (`src/lib/egress-guard.ts`) and applied it at both save time and send time:
  - Broker `baseUrl` (Alpaca / Alpaca-MCP connections, `app/api/connected-accounts/route.ts`):
    now requires `https://` and an official-host allowlist (extensible via
    `EGRESS_EXTRA_ALLOWED_HOSTS`, no code change needed). Previously accepted any string.
  - User-configured webhooks (`policy.notificationSettings.webhookUrl`,
    `app/api/policy/route.ts`, plus the two actual dispatchers in `src/lib/notify.ts` and
    `src/lib/notifications.ts`): now requires `http(s)`, resolves DNS, and rejects any
    resolved address that is loopback/RFC1918/link-local/metadata (169.254.169.254)/otherwise
    reserved — including several "encoded IP form" tricks (decimal/hex/octal IPv4, IPv4-mapped
    IPv6, NAT64, 6to4). Re-validated immediately before every send (not just at save time) to
    defeat DNS rebinding, and outbound webhook fetches now set `redirect: "manual"` so a 3xx
    response is never transparently followed to an unvalidated target.

- **Item 13 (unbounded bodies + per-request JWKS):** built one shared bounded-body helper
  (`src/lib/bounded-body.ts`) and applied it to all three call sites:
  - `app/api/webhooks/congress/route.ts` — previously trusted a declared `content-length`
    alone (an absent/understated header sailed through to an unbounded `req.text()`); now
    streams the body and aborts mid-read the moment the actual byte count exceeds the cap.
  - `app/api/webhooks/tradingview/route.ts` — previously had no cap at all; same fix.
  - `app/api/mobile/auth/apple/route.ts` — added the same bounded-body read (a JWT + optional
    name is a few KB at most), AND hoisted `createRemoteJWKSet(...)` from inside the `POST`
    handler to module scope so `jose`'s internal JWKS cache is actually reused across requests
    instead of being thrown away and re-fetched from `https://appleid.apple.com/auth/keys` on
    every sign-in.

## Why

Both items were flagged in the app-review backlog as genuine server-side security boundaries,
not paternalism toward the owner: an authenticated request that accepts an arbitrary broker
`baseUrl` or webhook target is a live SSRF/credential-exfiltration primitive regardless of who
is allowed to submit it, and trusting a client-declared `content-length` (or re-fetching a
public JWKS on every request) is a resource-exhaustion / needless-latency bug independent of
who the user is. Per repo instructions: "server-side security boundaries are correctness, not
paternalism — implement them fully."

Design decisions worth recording:

- **One guard module, two different policies.** Broker `baseUrl` is trusted with API
  credentials, so it gets a small fixed allowlist (HTTPS + exact host match, extensible via
  env). A user's own notification webhook legitimately points anywhere public, so it instead
  gets DNS resolution + a private/reserved-address blocklist — a host allowlist would be the
  wrong shape for "the owner's own receiver, which can be any domain."
- **Re-validate on send, not IP-pinning.** The task spec allowed either "pin the resolved IP
  for the actual fetch" or "re-validate on each send" to defeat DNS rebinding. Implemented the
  latter: `validateWebhookUrl` is called immediately before every outbound fetch in both
  `notify.ts`'s webhook channel and `notifications.ts`'s legacy webhook path, with no caching.
  Actual socket-level IP pinning would require a custom `undici.Agent`/connect-lookup override
  and `undici` is only a transitive dependency here (not in `package.json`), which felt like
  more coupling than the fix warranted. Redirects are never followed (`redirect: "manual"`),
  closing the classic "safe URL redirects to an internal one" bypass.
- **Deliberately did NOT lock down the Alpaca REST SDK's `baseUrl` or the `alpaca-mcp` raw
  `fetch()` call in `src/lib/alpaca.ts`.** Two existing, passing tests prove this is
  intentional, tested product behavior, not an oversight:
  - `test/persistence-notification.test.ts` — "sanitizes custom Alpaca baseUrl and
    instantiates client correctly" — seeds a connected account with
    `baseUrl: "https://custom-alpaca-endpoint.com/v2/"` directly via `upsertConnectedAccount`
    and expects the Alpaca SDK client to use it unmodified.
  - `test/alpaca-mcp.test.ts` — seeds `baseUrl: "http://localhost:8000/sse"` (plain HTTP,
    loopback) for an `alpaca-mcp` account and expects `callMcp`'s raw `fetch()` to hit it.

  Both bypass the HTTP route entirely (direct DB writes), which is exactly where the new guard
  lives. Enforcing HTTPS+allowlist inside `alpaca.ts`/`callMcp` itself would break both of
  these deliberately-supported self-hosted/custom-gateway paths. The real, externally-reachable
  attack surface — the `POST /api/connected-accounts` route that accepts a `baseUrl` string
  from a request body — is now fully gated; a legitimate self-hosted MCP endpoint or custom
  gateway added through that route requires `EGRESS_EXTRA_ALLOWED_HOSTS`, while direct DB
  writes (migrations, admin scripts, tests) remain unrestricted, matching existing behavior.
- **Tradier's existing baseUrl check was left as-is** (already environment-matched-host logic
  in `app/api/connected-accounts/route.ts` and `src/lib/tradier.ts`) rather than being
  rewritten to call the new shared utility — it already achieves an equivalent (arguably
  stronger, since it's environment-aware) result and is exercised by several passing tests;
  refactoring it purely for consistency wasn't worth the regression risk for a "surgical diff"
  ask. `TRADIER_ALLOWED_HOSTS` is still exported from `egress-guard.ts` for future
  consolidation.
- **Save-time webhookUrl re-validation is gated to "did this request actually change it"**
  (`enforceWebhookUrlRule` in `app/api/policy/route.ts`, mirroring the file's existing
  `enforceMarketableLimitBufferRule`/`enforceKeyedGreenModelRule` pattern) so a transient DNS
  blip on an already-saved, working webhook can't block every unrelated policy save (toggling
  an unrelated risk rule, etc.). The send-time guard is unconditional and is the actual
  authoritative boundary regardless.
- **`app/api/notifications/route.ts` (the per-user `NotifyPrefs.webhookUrl`, a different
  save path feeding the same `notify.ts` dispatcher) and `src/lib/mobile-api.ts`'s
  webhookUrl patch were intentionally NOT given a save-time guard** — only the two routes the
  task named (`connected-accounts`, `policy`) got save-time gates. This is safe because the
  SEND-time guard in `notify.ts`/`notifications.ts` is unconditional and applies regardless of
  which save path set the value — the dangerous action (the outbound fetch) is always checked.
  Flagging this as a small follow-up: adding the same save-time check to those two paths would
  be a fast-fail UX nicety, not a security requirement.
- **`notify.ts`'s webhook channel used to hard-require `https://`; it now allows `http://` too**
  (matching the task spec's "require http(s)" for user-configured webhooks) in exchange for a
  much stronger DNS/IP check replacing the old prefix-string check. No test asserted the old
  https-only message.
- **TradingView's byte cap (1 MB) and congress webhook's byte cap (5 MB, unchanged from the
  pre-existing declared-length threshold) were chosen per actual observed payload shape**: a
  Pine `alert()` payload is a few hundred bytes with no batching, while congress.trade batches
  can carry many trade events. Apple auth's cap (16 KB) covers a real identityToken JWT (~1-2
  KB) plus a name field with generous headroom.
- **A malformed Apple-auth JSON body now returns 400 instead of 401.** Previously any thrown
  error inside the single outer `try` (JSON parse failure included) fell through to the
  generic "Invalid identity token" 401. The new inner try/catch around the bounded body read
  distinguishes payload-too-large (413) and malformed JSON (400) from an actual failed
  JWT/signature verification (401). No existing test asserted the old status code (no test
  file existed for this route before this change).

## Files

- `src/lib/egress-guard.ts` (new) — shared SSRF guard: `validateBrokerBaseUrl` (sync,
  allowlist), `validateWebhookUrl` (async, DNS + private-range rejection), `isPrivateOrReservedIp`,
  `ALPACA_ALLOWED_HOSTS`, `TRADIER_ALLOWED_HOSTS`, `extraAllowedBrokerHosts` (env override).
- `src/lib/bounded-body.ts` (new) — shared bounded-body helper: `readBodyWithLimit`,
  `readJsonWithLimit`, `PayloadTooLargeError`, and the three byte-cap constants
  (`CONGRESS_WEBHOOK_MAX_BYTES` = 5 MB, `TRADINGVIEW_WEBHOOK_MAX_BYTES` = 1 MB,
  `APPLE_AUTH_MAX_BYTES` = 16 KB).
- `app/api/connected-accounts/route.ts` — Alpaca/Alpaca-MCP `baseUrl` now validated via
  `validateBrokerBaseUrl` against `ALPACA_ALLOWED_HOSTS` before being persisted.
- `app/api/policy/route.ts` — `notificationSettings.webhookUrl` now validated via
  `validateWebhookUrl` (async, gated by a new `enforceWebhookUrlRule` option mirroring the
  file's existing "only enforce when this request changes the field" pattern).
- `src/lib/notify.ts` — webhook channel's `send()` re-validates via `validateWebhookUrl`
  immediately before every fetch (injectable `resolveHost` threaded through
  `NotifyDispatchDeps` and the channel's send context); fetch now sets `redirect: "manual"`.
- `src/lib/notifications.ts` — `sendLegacyWebhook()` re-validates the same way (injectable
  `resolveWebhookHost` on `SendNotificationOptions`); fetch now sets `redirect: "manual"`.
- `app/api/webhooks/congress/route.ts` — declared-content-length fast-path kept, body now read
  via `readBodyWithLimit` (streaming abort) instead of unbounded `req.text()`.
- `app/api/webhooks/tradingview/route.ts` — same fix; this route previously had no cap at all.
- `app/api/mobile/auth/apple/route.ts` — `createRemoteJWKSet(...)` hoisted to module scope;
  body now read via `readJsonWithLimit`.
- Tests (new): `test/egress-guard.test.ts`, `test/bounded-body.test.ts`,
  `test/apple-auth-route.test.ts`.
- Tests (updated — added assertions): `test/connected-accounts-route.test.ts` (baseUrl
  allowlist accept/reject/env-override cases), `test/policy-notification-events.test.ts`
  (webhookUrl SSRF accept/reject/localhost/unchanged-value cases),
  `test/webhooks-tradingview.test.ts` (413/accept cases), `test/congress-trade-events.test.ts`
  (streaming-cap-without-header case).
- Tests (updated — injected a stub DNS resolver so the new send-time guard doesn't depend on
  real network/DNS in tests that use IANA-reserved test hostnames like `h.example`,
  `legacy.example`, `example.test`, or a real-but-unnecessary-to-hit host like `discord.com`):
  `test/notify.test.ts`, `test/notification-status-truth.test.ts`,
  `test/notification-body-fixes.test.ts`, `test/alternative-data.test.ts`,
  `test/persistence-notification.test.ts`.

## Verification

- `npx tsc --noEmit` — clean (exit 0). One earlier run flagged a type error in the new
  `test/apple-auth-route.test.ts` (mock tuple typing); fixed and re-ran to a clean exit.
- `npx vitest run test/egress-guard.test.ts test/bounded-body.test.ts test/apple-auth-route.test.ts`
  — 3 files, 45/45 passed (apple-auth re-run standalone after the type-only mock fix: 5/5).
- `npx vitest run` on the 13 existing/updated files (`test/notify.test.ts`,
  `test/notification-status-truth.test.ts`, `test/notification-body-fixes.test.ts`,
  `test/alternative-data.test.ts`, `test/persistence-notification.test.ts`,
  `test/connected-accounts-route.test.ts`, `test/policy-notification-events.test.ts`,
  `test/congress-trade-events.test.ts`, `test/congress-webhook-parity.test.ts`,
  `test/congress-webhook-auth.test.ts`, `test/webhooks-tradingview.test.ts`,
  `test/webhook-tradingview-trigger.test.ts`, `test/alpaca-mcp.test.ts`) —
  **153/155 passed**. The 2 failures ("writes one strategy_run audit event from
  runStrategyOnce" and "records a failed Green Team LLM step when the proposal request times
  out", both in `test/persistence-notification.test.ts`) are 30s-timeout failures of heavy
  `runStrategyOnce` end-to-end tests, **proven pre-existing/environmental**: re-running those
  two tests in a throwaway detached worktree at the unmodified HEAD (no changes from this
  effort) failed identically with the same 30s timeouts. The box was under extreme concurrent
  multi-agent load throughout (load average 60–92 on 10 cores, several parallel `tsc`/`vitest`
  processes from other sessions). Every webhook/notification/route test — i.e. everything this
  change actually touches — passed.
- No full `npm run build` per the task scope (focused verification only).

## Follow-ups

- `app/api/notifications/route.ts` (`NotifyPrefs.webhookUrl` save path) and
  `src/lib/mobile-api.ts`'s `notificationSettings.webhookUrl` patch have no save-time SSRF
  guard (only a `new URL(...)` parse check). Not a security gap — the send-time guard in
  `notify.ts`/`notifications.ts` is unconditional and catches it regardless of save path — but
  adding the same `validateWebhookUrl` call there would improve save-time UX (fail fast
  instead of only failing on the next actual send).
- Tradier's `baseUrl` check in `connected-accounts/route.ts` could be consolidated onto
  `validateBrokerBaseUrl`/`TRADIER_ALLOWED_HOSTS` for one code path instead of two, once there's
  appetite to touch and re-verify that already-well-tested logic.
- True IP-pinning for the webhook fetch (vs. re-validate-then-fetch-by-hostname) would close
  the very last sliver of a same-millisecond DNS-rebind race; not implemented per the task's
  explicit "or re-validate on each send" allowance.

## Blockers

- None. All planned changes landed; see Verification for the one transient tooling hiccup
  (machine load, not a code issue).
