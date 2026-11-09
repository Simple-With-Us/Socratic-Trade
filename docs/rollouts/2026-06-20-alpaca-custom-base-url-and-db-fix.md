# Rollout Note: Alpaca Custom Base URL and stable ENCRYPTION_KEY fix

## Summary
- Added support for configuring a custom **API Endpoint URL** (Base URL) when connecting Alpaca accounts, dynamically sanitizing and stripping trailing `/v2` segments to align with the Alpaca JS SDK's internal routing.
- Fixed a critical field-level encryption bug where `ENCRYPTION_KEY` was initialized randomly at boot time (due to early imports of `db.ts` before Next.js could populate environment variables), causing database decryption failures upon server restarts. We now dynamically load `.env.local` directly at the top of `src/lib/db.ts` (shielded from unit tests) to guarantee a stable encryption key.
- Verified and aligned the integration with the new `FintechStudiosEnrichmentProvider` for sentiment-based news scoring.

## Why
- Alpaca Paper trading accounts might use different endpoint URLs or custom developer URLs. The gateway lacked the option to override the API endpoint URL in the Accounts modal.
- The early-import env-evaluation race condition in `src/lib/db.ts` was generating temporary random keys when starting the Next.js dev server in PM2, making newly saved API keys completely undecryptable upon server/compiler restarts.

## Files Touched
- [app/api/connected-accounts/route.ts](file:///Users/jay/apps/trading-antigravity/app/api/connected-accounts/route.ts)
- [app/dashboard-client.tsx](file:///Users/jay/apps/trading-antigravity/app/dashboard-client.tsx)
- [app/ui/dashboard/settings.tsx](file:///Users/jay/apps/trading-antigravity/app/ui/dashboard/settings.tsx)
- [src/lib/alpaca.ts](file:///Users/jay/apps/trading-antigravity/src/lib/alpaca.ts)
- [src/lib/data-providers.ts](file:///Users/jay/apps/trading-antigravity/src/lib/data-providers.ts)
- [src/lib/db.ts](file:///Users/jay/apps/trading-antigravity/src/lib/db.ts)
- [src/lib/types.ts](file:///Users/jay/apps/trading-antigravity/src/lib/types.ts)
- [test/data-providers.test.ts](file:///Users/jay/apps/trading-antigravity/test/data-providers.test.ts)
- [test/persistence-notification.test.ts](file:///Users/jay/apps/trading-antigravity/test/persistence-notification.test.ts)

## Verification
1. `npx tsc --noEmit` - Compiler verification passed successfully with no errors.
2. `npm test` - Vitest test suite ran cleanly (49 files, 390 tests passed).
3. `npm run build` - Full Next.js production build succeeded.
4. `pm2 restart trading-antigravity --update-env` - Verified PM2 service restart is healthy.

## Follow-ups
- Ask the user to remove and re-add their Alpaca Paper account from the Accounts modal. Since the server was running with a temporary random key when the account was first connected, the old credentials stored in `data/app.db` cannot be decrypted. Re-adding the account now will encrypt them with the correct stable key.
