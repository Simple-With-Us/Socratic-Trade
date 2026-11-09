# Rollout Note: Alpaca Single-Key & OAuth Authentication Support

## Summary
Updated the Alpaca integration to fully support accounts with only an API Key (OAuth token) and no separate Secret Key. We now dynamically handle authentication over both REST requests (swapping headers to `Authorization: Bearer <token>`) and WebSocket connections (swapping handshake payload to `{ action: "auth", key: "oauth", secret: token }`) when the secret key is empty.

For the official `@alpacahq/alpaca-trade-api` client constructor, when a secret key is not provided, the SDK uses the `oauth` string parameter directly to attach `Authorization: Bearer <token>` to requests. We updated `src/lib/alpaca.ts` to construct the SDK configuration accordingly.

## Why
Alpaca Paper environments only utilize a single API Key (the Key ID) with no separate Secret Key. The platform previously assumed standard API key-pair authentication (requiring both key and secret), blocking connection or stream startup when the secret key was absent, and initially structured the SDK option as an object instead of the required plain string.

## Files Touched
- [src/lib/alpaca.ts](file:///Users/jay/Code/Agentic%20Trading/src/lib/alpaca.ts)
- [src/lib/data-providers.ts](file:///Users/jay/Code/Agentic%20Trading/src/lib/data-providers.ts)
- [src/lib/streams/alpaca-news-stream.ts](file:///Users/jay/Code/Agentic%20Trading/src/lib/streams/alpaca-news-stream.ts)
- [src/lib/streams/alpaca-trade-updates-stream.ts](file:///Users/jay/Code/Agentic%20Trading/src/lib/streams/alpaca-trade-updates-stream.ts)
- [app/dashboard-client.tsx](file:///Users/jay/Code/Agentic%20Trading/app/dashboard-client.tsx)
- [app/ui/dashboard/settings.tsx](file:///Users/jay/Code/Agentic%20Trading/app/ui/dashboard/settings.tsx)

## Verification
Ran all verification commands in the required sequence:
1. `npx tsc --noEmit` - Type verification passed with zero errors.
2. `npm test` - Vitest test suite ran successfully (37 files, 261 tests passed).
3. `npm run build` - Full Next.js production build succeeded.

## Follow-ups
None. The single-key authentication has been successfully integrated.
