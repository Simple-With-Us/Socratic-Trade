# 2026-06-24 — Macro ticker consistency + Alpaca account inference

## Summary

Macro-tab tickers now behave like Market Scan tickers, and Alpaca account setup
now infers Paper from both Paper account numbers and Paper API keys.

## Why

Macro movers/news showed tickers without the same hover/click affordance used in
Market Scan. Alpaca setup also had a noisy endpoint explainer, inferred Paper only
from `PA...` account numbers, and showed the live endpoint with `/v2` even though
the Alpaca dashboard lists live keys against `https://api.alpaca.markets`.

## Files

- `app/ui/symbol-button.tsx`
- `app/dashboard-client.tsx`
- `app/ui/macro-panel.tsx`
- `app/api/connected-accounts/route.ts`
- `src/lib/alpaca.ts`
- `test/connected-accounts-route.test.ts`
- `test/alpaca-account-type.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-24-ticker-alpaca-production-update.md`

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run test/connected-accounts-route.test.ts test/alpaca-account-type.test.ts` — 4 tests passed.
- `npm test` — 123 files / 1066 tests passed.
- `npm run build` — passed. Next.js rewrote `next-env.d.ts` / `tsconfig.json` during build; that generated drift was restored.
- `git diff --check` — clean.
- GitHub Security/gitleaks initially flagged synthetic Alpaca-looking test fixtures on the abandoned PR branch; this clean branch uses de-secretized fixture strings only.

## Follow-ups

- Production update was requested after this patch. Landing through `main` should trigger the self-hosted Deploy workflow for `socratictrade.com`.
- Alpaca account type can only be automatic when Alpaca returns subtype fields such
  as `account_type` / `account_sub_type`; otherwise tax treatment remains manual.
