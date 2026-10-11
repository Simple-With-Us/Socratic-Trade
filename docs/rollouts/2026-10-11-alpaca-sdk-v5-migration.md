# Alpaca Trade API SDK v5 migration

## Context & Objective

Renovate bumps of `@alpacahq/alpaca-trade-api` to v5 broke `tsc` because the v3 facade (`getAccount`, `createOrder`, `sendRequest`, …) was removed in favor of `alpaca.trading.*` and `alpaca.marketData.*`.  This change completes a dedicated migration so dependency updates can land without a silent broker outage.

## Changes Made

- Bumped `@alpacahq/alpaca-trade-api` to `^5.0.0` (`package.json`, lockfile).
- Added `src/lib/alpaca-sdk-legacy-client.ts` — maps v5 clients to the v3-shaped REST surface `AlpacaBrokerGateway` still calls, including camelCase → snake_case normalization for account/order payloads.
- Updated `src/lib/alpaca.ts` to construct the legacy adapter, handle v5 `ApiError.status`, and make the old axios timeout pin optional (v5 uses `fetch` + `timeoutMs`).
- Updated Alpaca vitest mocks to export both `Alpaca` and `default` for the v5 named export.

## Decisions & Trade-offs

- **Adapter layer vs wholesale gateway rewrite:**  Adapter keeps MCP/REST call sites and tests stable; v5 is isolated to one module.
- **Custom `baseUrl`:**  Passed as `basePath` on the v5 client options when a connected account sets a non-MCP REST host (same strip-`/v2` behavior as v3).
- **Vitest mocks:**  Legacy detection uses prototype `trading` getter presence so partial mocks (e.g. quotes-only) are not mistaken for the v5 facade.

## Verification State

```bash
npm run lint          # 0 errors
npx tsc --noEmit      # clean
npm test -- test/alpaca-*.test.ts test/broker-io-deadlines.test.ts test/broker-side.test.ts test/order-confirmation-status.test.ts  # 106 passed
npm run build         # clean
```

Production deploy SHA (ST):

```bash
bash scripts/verify-deploy-sha.sh
# PASS: live 01441e3d6843ed1bca45d93df865d5a85539e0cc contains origin/main
```

Cross-app notes (same script pattern, other repos):

- **Usage Monitor:**  `https://usage.jays.services/api/health` → `.revision` = `63fd32a01cc8e422e65fbd640bc0bd9843b847b1` (no `.checks.release.sha`).
- **Congress.Trade:**  `https://congress.trade/api/health` does not expose `.checks.release.sha` on the health payload checked 2026-10-11; use that app's deploy verification path.

## Next Steps & Blockers

- Merge PR; weekend/evening auto-deploy will pick up runtime changes on `main`.
- Re-close Renovate Alpaca v5 PRs that were superseded by this migration.

## Zero-Code Findings

None beyond deploy verification above.
