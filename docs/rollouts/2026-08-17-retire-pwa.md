# 2026-08-17 — Remove leftover installable PWA

## 1. Context & Objective

The owner does not use the PWA and asked to disable or delete it.  The 2026-08-16
review-UX pass already redirected `/mobile` and `mobile.socratictrade.com` to
`/console`, but left the standalone web-app manifest, `apple-mobile-web-app-capable`,
and the unused PWA client tree in place — so the website was still installable.

This pass finishes retirement: no installable/offline PWA, no stale service-worker
cache path, desktop + phone website and native iOS unchanged.

## 2. Changes Made

- Deleted the unused PWA UI (`app/mobile/mobile-pwa-client.tsx` and components).
  `app/mobile/page.tsx` remains a redirect to `/console`.
- Removed `app/manifest.ts` (standalone `display`) and the layout `manifest` /
  `appleWebApp: { capable: true }` metadata so browsers no longer treat the site
  as an installable app.
- Middleware now redirects `/mobile` and `/mobile/*` on every host (not only the
  mobile subdomain) and returns **410** for `/manifest.webmanifest`.
- Added a page-load unregister script plus `public/sw.js` kill-switch so leftover
  workers drop Cache Storage instead of serving stale HTML.
- `/api/mobile/*` and `src/lib/mobile-api.ts` are untouched (native iOS).
- Favicons / apple-touch-icon PNGs stay as normal website icons.  iOS App Icon
  generation is unchanged.

### Files

- `app/mobile/page.tsx`
- `app/mobile/mobile-pwa-client.tsx` (deleted)
- `app/mobile/components/*` (deleted)
- `app/manifest.ts` (deleted)
- `app/layout.tsx`
- `middleware.ts`
- `next.config.mjs`
- `public/sw.js` (new)
- `src/lib/pwa-unregister.ts` (new)
- `src/lib/push-deep-links.ts`
- `src/lib/symbol-desk.ts`
- `app/console/console.css`
- `scripts/generate-pwa-icons.mjs`
- `eslint.config.mjs`
- `test/pwa-retired-redirect.test.ts`
- `test/middleware-auth.test.ts`
- `test/subdomain-routing.test.ts`
- `test/mobile-pwa-client.test.tsx` (deleted)
- `AGENTS.md`
- `docs/mobile-api-and-clients.md`
- `docs/phase-11-multi-user.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-17-retire-pwa.md`

## 3. Decisions & Trade-offs

- Did not delete `/api/mobile/*`.  That is the iOS command gateway, not a PWA.
- Did not delete favicon PNGs or `scripts/generate-pwa-icons.mjs` (still builds
  website icons + the iOS 1024 App Icon).
- Did not add a new service-worker registration.  `public/sw.js` only exists so
  a leftover worker at that URL updates to a self-unregistering file.
- Clearing Cache Storage on every page load is intentional and cheap when empty.
  This site does not use the Cache API for the console.
- Historical rollout notes that describe the old PWA were left as history.

## 4. Verification State

```
npm run lint
# 0 errors (744 grandfathered warnings)

npx tsc --noEmit
# exit 0

npx vitest run test/pwa-retired-redirect.test.ts \
  test/middleware-auth.test.ts test/subdomain-routing.test.ts
# 3 files / 52 passed

npx vitest run test/mobile-api.test.ts test/mobile-auth-exchange-route.test.ts \
  test/mobile-auth-handoff.test.ts test/mobile-account-deletion-route.test.ts \
  test/mobile-order-cancel.test.ts test/mobile-stop-preemption.test.ts \
  test/mobile-view-scope.test.ts test/mobile-policy-precondition.test.ts \
  test/stale-mobile-commands.test.ts test/apple-app-site-association-route.test.ts
# 10 files / 46 passed (iOS gateway unchanged)

npm test
# 578 files passed / 21 failed / 1 skipped
# 6860 passed / 37 failed / 51 skipped
# Failures are unrelated env/network suites (Yahoo, Voyage/SiliconFlow,
# notify, SEC coverage, usage-monitor).  None import the deleted PWA client
# or manifest.

npm run build
# exit 0.  Routes include ƒ /mobile (redirect) and /api/mobile/*.
# No /manifest.webmanifest route.
```

iOS sources were not edited.  No `xcodebuild` required.

## 5. Next Steps & Blockers

- After deploy: anyone who still has an old home-screen icon can delete it;
  opening it will land on `/console` in the browser once the worker unregisters.
- Do not rebuild `app/manifest.ts` or a `/mobile` client.

## 6. Zero-Code Findings

None.  The 2026-08-16 redirect was real, but installability was still live via
`app/manifest.ts` + `appleWebApp.capable`.
