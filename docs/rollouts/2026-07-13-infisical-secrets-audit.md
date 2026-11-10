# Rollout Note: Infisical Secrets and Machine Identity Audit (2026-07-13)

## Summary
Audited the Coolify environment variables and matched them against local machine identities. Cleaned up redundant operational variables and streams configurations from Coolify, migrating them to Infisical to establish Infisical as the 100% sole source of truth for all runtime operations.

## Why
To enforce the principle of least privilege and single-source-of-truth configuration management. Storing app configs or feature flags directly in Coolify spreads environment variables across two different control planes. Moving them to Infisical simplifies deployments and keeps configurations consistent across development, staging, and production environments.

## Touched Files / Settings
* **Infisical (prod/dev/staging)**:
  * Added `STREAMS_ALPACA_NEWS_ENABLED=on`
  * Added `STREAMS_ALPACA_TRADE_UPDATES_ENABLED=on`
  * Added `STREAMS_ALPACA_PRICE_EVENTS_ENABLED=on`
  * Added `TRIGGER_ENGINE=on`
  * Added `REQUIRE_SECRETS_MANAGER=1`
  * Added `NODE_ENV=production` (`NODE_ENV=development` in dev)
  * Added `DB_BOOTSTRAP=live` in prod (`fresh` in dev/staging)
* **Coolify (socratic-trade-prod)**:
  * Deleted `DB_BOOTSTRAP`
  * Deleted `REQUIRE_SECRETS_MANAGER`
  * Deleted `NODE_ENV`
  * Verified Nixpacks builder variables (`NIXPACKS_PKGS`, `NIXPACKS_NODE_VERSION`) and bootstrap credentials (`INFISICAL_*`) are correct.
* **Workspace**:
  * Modified: [STATUS.md](file:///Users/jay/apps/trading-ag-rag/STATUS.md)

## Verification
* Checked the Coolify application API endpoint to verify the list of variables.
* Successfully removed the redundant keys by their UUIDs.
* Triggered a redeployment on Coolify.
