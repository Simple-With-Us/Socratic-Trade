# 2026-08-13 — Fleet Pushover / Sentry / Uptime triage

## Context & Objective

Owner sent a Pushover stack from 8:06–8:44am CT and asked to resolve recent issues, errors, and alerts across the fleet.  The four cards are four different bugs.  UptimeRobot 503s on `socratictrade.com` were pairing with a false "OpenRouter credits low" because both monitors hit the same `/api/health` URL.

## Changes Made

- Robinhood MCP option-chain and historicals calls now send only the live schema fields.  `get_option_chains` gets `underlying_symbol` only.  `get_option_instruments` gets `chain_symbol` (plus optional `expiration_dates` / `type`).  `get_equity_historicals` gets `symbols` + RFC3339 `start_time` instead of the rejected `symbol` / `span` pair.  This is GH #2576 / Sentry SOCRATIC-TRADE-K and SOCRATIC-TRADE-1Y.
- Pinecone metadata is capped under 40960 bytes (soft 40896) by truncating `text` first.  Production upserts were 40962 bytes and paged as "Pinecone connection failed" (SOCRATIC-TRADE-1T).
- OpenRouter "engine is currently overloaded" 429s classify as `transient`.  They no longer fire Sentry, `provider_degraded`, or `alertUsageLimitHit`.  A plain 429 still goes through the usage-limit lane.
- UptimeRobot keyword monitor 803542990 (`OpenRouter credits low`) now treats 4xx/5xx as success so a deploy 503 cannot look like drained credits.  Real `openrouterCredits.ok=false` on a 200 still pages.
- Closed already-shipped product-review bugs #2593, #2592, #2578 (all on main via #2646).

### Files

- `src/lib/robinhood.ts`
- `src/lib/vector-db.ts`
- `test/robinhood-mcp.test.ts`
- `test/pinecone-metadata-and-rag-limits.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-13-fleet-alert-triage.md`

## Decisions & Trade-offs

- Did not suppress remonitor for CT senate `upstream-maintenance`.  Classification is wrong for this incident: Mac `senate-relay` has been returning 200s while the scout re-handshakes every poll and 503s.  Server `/api/health/polling` senate is ok.  Follow-up is scout session reuse in the CT lane, not a remonitor mute.
- Did not create or rotate any provider keys.  `filingapi` 401 (SOCRATIC-TRADE-1G) is a real credential problem; owner supplies keys via `~/.secrets/`.
- Transient-overload classification is narrower than generic 429 so genuine quota pages still fire.

## Verification State

```bash
npx vitest run test/robinhood-mcp.test.ts test/pinecone-metadata-and-rag-limits.test.ts test/robinhood-tenant-isolation.test.ts
# 3 files / 35 passed

npx vitest run test/vector-db-scope.test.ts test/vector-db-backlog-c-integration.test.ts test/vector-db-asof-server-filter.test.ts test/usage-limit-alerts.test.ts
# 4 files / 65 passed
```

Full `lint` / `tsc` / `npm test` / `npm run build` run via `scripts/land.sh`.

Uptime: all 9 monitors UP at triage time.  ST 503 windows on Aug 13 were 1–11 minutes and lined up with deploys, not a stuck container.

## Next Steps & Blockers

- CT: make `detectSenateOnce` reuse the senate-relay session instead of a fresh handshake every poll.
- Owner: check the `filingapi` env key (401 since Aug 3).  Do not mint a new key.
- After this lands: resolve Sentry SOCRATIC-TRADE-K / 1Y / 1T / 1X as resolved-in-next-release.
- Claude `claude/health-alert-noise` is still the lane for consecutive-failure gating on other connection-failed pages.

## Zero-Code Findings

- `OpenRouter credits low` (UptimeRobot 803542990) is a KEYWORD monitor on `https://socratictrade.com/api/health` matching `"openrouterCredits":{"ok":false`.  Every ST 503 also opened that incident.  Allowed 4xx/5xx on that monitor only.
- A dedicated UM monitor already exists (`usage.jays.services/api/openrouter-credits`).
- congress.trade 502 blips are Coolify compose cutovers (container gone before the new one exists), documented in `docs/rollouts/2026-08-12-deploy-downtime-gap.md` on CT.
