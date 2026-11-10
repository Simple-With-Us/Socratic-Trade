# 2026-08-22 — Owner candlestick ST favicon, ASC listing, Android master

## Context & Objective

Owner attached a transparent 1024 candlestick ST (Grok chat `update-ST`) and asked to use it as the website favicon and the future Android launcher.  A follow-up (`also-update`) asked to update the App Store Connect listing icon, not the iOS home-screen App Icon.

## Changes Made

- Installed `graphics/st-candlestick-favicon-owner.png` as the source mark.
- Website: `public/icon.png` (1024 RGBA) plus 32 / 192 / 512.  Apple-touch PNGs flatten onto black so iOS does not fill holes with a white plate.
- ASC listing upload: `graphics/asc-app-icon-1024.png` (1024 RGB, no alpha).
- Future Android: `graphics/android-launcher-icon-1024.png` (1024 RGBA).  No Android app in this repo yet.
- `scripts/generate-favicon-st.mjs` no longer crops the iOS App Icon.  Native `AppIcon-1024.png` is untouched.
- `app/layout.tsx` serves the 32px tab icon first.

## GitHub login (from `ST-github`)

Auth.js uses a GitHub **OAuth App**, not Coolify GitHub App `4238447`.

| Field | Value |
|---|---|
| Homepage URL | `https://socratictrade.com` |
| Authorization callback URL | `https://socratictrade.com/api/auth/callback/github` |

Coolify deploys stay on SSH + `https://host.jays.services/webhooks/source/github/events/manual`.  App `4238447` was unused and may be deleted by the owner.

## Verification

```
node scripts/generate-favicon-st.mjs
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/favicon-st.test.ts
```

Did not replace `ios/.../AppIcon-1024.png`.  Did not click Coolify Deploy.  ASC upload is still a human step in App Store Connect (App Information / General).

## Next Steps & Blockers

Owner uploads `graphics/asc-app-icon-1024.png` in ASC.  Android project can copy `graphics/android-launcher-icon-1024.png` when that app exists.
