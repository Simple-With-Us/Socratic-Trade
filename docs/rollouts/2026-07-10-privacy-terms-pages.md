# 2026-07-10 — Privacy Policy and Terms and Conditions pages (Twilio setup) (MONET)

## Summary

Added two boilerplate public pages: `/privacy-policy` and `/terms-and-conditions`, off the main
`socratictrade.com` domain. Owner needs live URLs for Twilio's toll-free/A2P messaging verification
(Twilio's compliance review requires a reachable, publicly viewable privacy policy and terms of
service before it will approve SMS sending).

## Why these specific contents

The app already has a real, opt-in, user-configured SMS notification channel (`src/lib/notify.ts`,
Twilio-backed, gated behind a user-supplied phone number in Settings). Both pages were written to
describe that real behavior — not invented capabilities — and both include the specific language
Twilio's compliance reviewers look for on an SMS-sending site: opt-in consent, message frequency
varies, "message and data rates may apply," STOP-to-opt-out / HELP instructions, and a statement
that phone numbers aren't sold/shared for marketing. This is boilerplate, not a lawyer-drafted
policy — reasonable for a Twilio verification submission on a sole-operator product, but the owner
should have counsel review before treating it as a complete legal document if the product scales.

## Files

- `app/privacy-policy/page.tsx` (new) — matches the existing `/how-it-works`/`/welcome` header/footer/
  Card pattern exactly (self-contained, no shared layout component, per existing precedent).
- `app/terms-and-conditions/page.tsx` (new) — same pattern.
- `app/sitemap.ts` — both pages added (low priority, yearly change frequency — legal boilerplate).
- `app/robots.ts` — both paths added to the crawl `allow` list (only takes effect once
  `NEXT_PUBLIC_ALLOW_INDEXING=true`; robots.txt doesn't gate direct URL reachability either way).
- `middleware.ts` — **the actual thing that would have broken Twilio's review**: both paths added to
  `PUBLIC_PREFIXES` so they don't redirect to `/login` for an unauthenticated visitor (every other
  path in this app requires a signed-in identity). Caught by checking middleware before assuming the
  new routes were reachable.
- `.claude/launch.json` (new, this worktree only, not previously present) — `next dev` launch config
  for the Browser preview tool, used to verify these pages render live.

## Verification

node@24 (Mac default is node26 — better-sqlite3 ABI trap).

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx tsc --noEmit                                                              # clean
npx eslint app/privacy-policy/page.tsx app/terms-and-conditions/page.tsx \
  app/sitemap.ts app/robots.ts middleware.ts                                  # 0 errors
npx vitest run                                                                # 315 files / 3395 tests
npm run build                                                                 # clean; /privacy-policy
                                                                                # and /terms-and-conditions
                                                                                # both static (○)
```

Driven live via the Browser preview tool (`next dev`, node@24): navigated to both
`/privacy-policy` and `/terms-and-conditions` unauthenticated — both rendered full content (no
redirect to `/login`), correct `<title>`, matching site styling.

## Follow-ups

- Owner: paste the live URLs (`https://socratictrade.com/privacy-policy`,
  `https://socratictrade.com/terms-and-conditions`) into the Twilio console's toll-free/campaign
  verification form.
- If the product scales beyond a sole operator, have counsel review both pages before relying on
  them as complete legal documents.
