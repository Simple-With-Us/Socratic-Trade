# 2026-06-30 - Browser Tab Title

## Summary

Updated the root and welcome-route metadata so the browser tab document title is exactly `Socratic Trade`.

## Why

The browser tab/hover text comes from the HTML `<title>` element. In Next.js App Router, that element is generated from route metadata. The root default title and welcome route still used the longer marketing title, so production showed `AI market research & strategy dashboard` in the tab.

## Files

- `app/layout.tsx`
- `app/welcome/page.tsx`
- `PLAN.md`
- `STATUS.md`
- `docs/rollouts/2026-06-30-browser-title.md`

## Verification

- `bash scripts/npm-ci-with-shared-deps.sh` - installed dependencies in the isolated worktree; npm reported the existing two moderate audit findings.
- `npm run lint` - passed with 0 errors and the existing warning backlog.
- `npx tsc --noEmit` - passed.
- `npm test` - first run hit a load-sensitive timeout in `test/persistence-notification.test.ts`; targeted rerun passed 17/17.
- `npm test` - full rerun passed 159 files / 1538 tests.
- `npm run build` - passed; existing Next middleware-to-proxy deprecation warning only.
- Generated `/welcome` HTML title extraction - `.next/server/app/welcome.html: Socratic Trade`.

## Follow-ups

- After merge/deploy, verify `socratictrade.com` serves `<title>Socratic Trade</title>` or equivalent browser title behavior.
