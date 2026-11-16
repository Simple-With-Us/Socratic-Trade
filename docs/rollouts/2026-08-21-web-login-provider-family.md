# Website login: one provider family (Google Light/Dark chrome)

2026-08-21 · GROK · branch `grok/login-unify-web`

## Why

The owner asked for Apple / Google / GitHub to look like one family while staying
branded.  iOS landed that in #3008 (`072574569`): Google's Light/Dark colour table,
official marks, a custom Sign in with Apple button the HIG permits for logo
alignment, `.buttonStyle(.plain)` so SwiftUI stopped painting grey chrome.

The website `app/login/page.tsx` was left as three treatments: teal Google (`bg-accent`
with the color G — an explicit Google Don't), outlined GitHub, black Apple.  Live
`socratictrade.com/login` still served that teal Google button after #3008 deployed.

## What changed

- Shared `.login-provider-btn` chrome: fill `#FFFFFF` / `#131314`, 1px stroke
  `#747775` / `#8E918F`, 44px tall, 10px radius, 20px logo slot, 19px title.
- Google title ink `#1F1F1F` / `#E3E3E3`.  Apple title/logo stay pure black or
  white (`login-provider-btn--apple`).
- GitHub mark is the official Invertocat (`viewBox="0 0 98 96"` from
  brand.github.com), `currentColor`.
- Source test `test/login-provider-buttons.test.ts` refuses a teal Google button
  and requires the shared class plus Invertocat path.

iOS `LoginView.swift` is unchanged.  Apple web sign-in is still env-gated; the
button is ready when `AUTH_APPLE_*` is on.

## Verification

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/login-provider-buttons.test.ts
```

Browser: local `/login` in light (product default) and after `localStorage.theme='dark'`.
Production still shows the old teal Google until this merges and Coolify deploys.

## Follow-ups

- Lane 1 (CT App Store) is still owner-blocked on the physical-device deletion
  recording.  Do not submit against build `202608202100`.
- Strategy-run P0 `06df80cf`: equity-floor skip fires before gather.  Do not treat
  #3018 as the explanation for a counter that never moved.
