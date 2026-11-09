# 2026-06-18: Multi-account hardening review

## Summary
Reviewed the current Phase 10 worktree and fixed concrete multi-account, profile, and UI clarity issues found during the review.

## Why
The app claimed dynamic multi-account credential routing, but connected-account keys were stored/returned separately from the encrypted `user_api_keys` path and Alpaca did not read the selected connected-account credentials. Profile activation also had a runtime SQL binding bug that TypeScript could not catch.

## Files
- `app/api/connected-accounts/route.ts` - validate broker/environment, trim input, and derive a default label when the UI leaves it blank.
- `app/dashboard-client.tsx` - restore a command-bar `Manage Accounts...` option so users can reach account setup from an empty selector.
- `app/ui/symbol-drilldown.tsx` - label normalized 0-100 factor values as `Factor Scores`.
- `src/lib/alpaca.ts` - prefer active connected-account Alpaca credentials before legacy per-user/env fallbacks.
- `src/lib/dashboard.ts` - pass `userId` into broker gateway selection.
- `src/lib/db.ts` - fix active-profile setting persistence, hide connected-account secrets from dashboard listings, decrypt only active backend credentials, encrypt connected-account key fields at rest, preserve keys on metadata edits, and reject invalid account activation.
- `test/persistence-notification.test.ts` - add regression coverage for profile activation and connected-account credential handling.
- `STATUS.md`, `PLAN.md`, `docs/phase-11-multi-user.md` - update handoff and phase status.

## Verification
- `npx tsc --noEmit` initially failed on stale duplicated `.next/types/* 2.ts` generated files.
- First `npm run build` attempts failed with stale/corrupted `.next` output while a dev server was active (`Cannot find module './331.js'`, then `Cannot find module for page: /_document`).
- Deleted the generated `.next` directory and rebuilt from a clean output tree.
- `npm run build` passed.
- `npx tsc --noEmit` passed.
- `npm test` passed: 26 files, 188 tests.
- Final `npm run build` passed.

## Follow-ups
- `next dev` emitted repeated `EMFILE: too many open files, watch` warnings and restarted repeatedly after claiming `next.config.mjs` changed. An orphan Node listener remained on port `3000`; stopping it was blocked by environment approval/usage limits.
- Add a general API Keys settings tab for OpenAI/Finnhub/FMP/Alpha Vantage/FRED/Voyage/Pinecone instead of mixing provider keys with brokerage-account credentials.
- Route all provider code through `resolveApiKey(service, userId)` with source attribution so users can tell whether a value came from their key, an env fallback, or a no-key source.
- Add explicit live-Alpaca enablement/confirmation before allowing `environment: "live"` to create non-paper Alpaca clients.
