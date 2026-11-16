# 2026-07-17 - congress-webhook-signature-fix

## Summary

Fixed the inbound congress.trade webhook receiver (`app/api/webhooks/congress/route.ts`,
via `src/lib/congress-webhook-auth.ts`) rejecting every signed delivery with `401`. The
verifier compared the raw `X-Signature` header (including congress.trade's `sha256=`
prefix) against the bare hex HMAC digest using an exact byte-length check, so the lengths
could never match. Every delivery fell through to the absent bearer-token fallback and was
rejected, burning all 5 of congress.trade's retries before it gave up and emailed its admin.
Only the SSE delivery path was actually interoperating.

## Why

Flagged in a Congress.Trade cross-agent multi-agent-audit closeout in `#ag***-s**c` on
2026-07-12: "Socratic webhook channel is dead on arrival: webhook.ts:317 sends
`X-Signature: sha256=<hex>` but Socratic's verifier compares bare hex — every signed
delivery 401s and burns all 5 retries; only SSE interops. Fix belongs in
congress-trading-shared (shared sign/verify pair)." The shared package
(`congress-trading-shared/src/webhookAuth.ts`) already has a correct verifier that strips
the optional `sha256=` prefix (comment: "Tolerates the optional 'sha256=' prefix
historically sent by Congress.Trade"), but this repo's live route was never migrated to it
— `congress-webhook-auth.ts` stayed a separate, still-broken duplicate. The bug was
therefore still live 5 days after being reported. Confirmed still reproducing via
Congress.Trade's admin dashboard delivery log as of 2026-07-17 (repeating batches of 5
failed deliveries per filing, matching congress.trade's `MAX_ATTEMPTS`).

## Files

- `src/lib/congress-webhook-auth.ts` — strip an optional, case-insensitive `sha256=`
  prefix from the `X-Signature` header before the constant-time hex comparison, mirroring
  `congress-trading-shared`'s verifier.
- `test/congress-webhook-auth.test.ts` — new regression coverage: prefixed (the actual
  wire format), unprefixed (legacy/bare hex), uppercase-prefixed, tampered-signature, and
  no-secret-configured cases.

## Verification

- `npx vitest run test/congress-webhook-auth.test.ts` — 5/5 passed
- `npx tsc --noEmit` — clean
- `npm run lint` — 0 errors (491 pre-existing warnings, all unrelated to this change)
- `npm test` — 404 files / 4701 tests passed
- `npm run build` — clean

## Follow-ups

- Consider migrating this route onto `congress-trading-shared`'s
  `verifyCongressWebhookSignature`/`signCongressWebhook` pair directly instead of keeping a
  parallel local implementation, so the two verifiers can't silently diverge again.
- Congress.Trade should confirm its admin dashboard delivery log stops showing new `401`
  batches for this subscriber once this deploys.
