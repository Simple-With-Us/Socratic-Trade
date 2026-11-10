# 2026-08-06 — R2 alert subject identity + staggered fleet checks [GROK]

## Owner problem
Socratic Trade multi-account R2 monitor was sending CT/UM free-tier alerts under
the **Socratic Trade** Pushover app logo. Daily digests bundled all three
accounts into one ST-logo message. Peer checks could fire near home-app digests.

## Contract (ST + CT + UM)

1. **Subject logo:** Pushover *application* token is chosen by the free-tier
   account the message is **about**:
   - ST → `PUSHOVER_ST_API_TOKEN` (or `PUSHOVER_APP_TOKEN` on ST host)
   - CT → `PUSHOVER_CT_API_TOKEN` (or `PUSHOVER_APP_TOKEN` on CT host)
   - UM → `PUSHOVER_USAGE_API_TOKEN`
2. **Runner footer:** `(sent from <App Name>)` only when the runner is **not**
   the same product as the subject logo (e.g. ST messaging under CT/UM token).
   Same-product messages omit the footer.
3. **Peer GraphQL stagger (ST multi-account):** home free tier always; peers only
   when `utcHour % 6 === phase` — ST=2, CT=4, UM=0. Force all:
   `R2_USAGE_CHECK_ALL_ACCOUNTS=1`.
4. **Daily digest hours:** UM≥08Z, ST=14Z, CT≥20Z (env `R2_USAGE_DIGEST_UTC_HOUR`).
5. **Own backup line:** digests mention shallow litestream→R2 + **Hetzner ~24h
   volume PITR floor** (do not require multi-day R2 LTX history).

## Ops
- Ensure Infisical/Coolify has all three subject tokens on ST (so peer logos work).
- CT prefers `PUSHOVER_CT_API_TOKEN`; falls back to `PUSHOVER_APP_TOKEN`.
- UM unchanged preferred token; always stamps sent-from footer.

## Tests
- ST: `npx vitest run test/r2-usage.test.ts`
- CT: `npx vitest run src/shared/r2Usage.test.ts`
- UM: `npx vitest run src/lib/__tests__/r2-usage.test.ts`
