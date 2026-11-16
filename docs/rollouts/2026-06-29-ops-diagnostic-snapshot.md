# 2026-06-29 — Ops diagnostic snapshot API

## Summary
- Added `GET /api/ops/snapshot` — token-gated operational snapshot for remote agents/curl.
- Returns per-user: connected accounts (autonomy mode, LLM model, key configured flag),
  recent `strategy_runs` with `connectedAccountId` + label, and recent ops-relevant audit rows.
- Middleware: `/api/ops` added to `PUBLIC_PREFIXES`; auth is token-only inside the handler.

## Why
- Cursor cloud agent cannot OAuth into `socratictrade.com` or read `data/app.db` on the Mac.
- Needed a safe way to inspect production strategy-run failures and per-account state remotely.

## Files
- `app/api/ops/snapshot/route.ts`
- `src/lib/ops-auth.ts`
- `src/lib/ops-snapshot.ts`
- `middleware.ts`
- `.env.example`
- `test/ops-snapshot.test.ts`
- `STATUS.md`, `docs/rollouts/2026-06-29-ops-diagnostic-snapshot.md`

## Verification
- `npx vitest run test/ops-snapshot.test.ts` — 2 passed
- `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` — run before merge

## Production setup (owner)
1. Generate a long random token: `openssl rand -hex 32`
2. Set `OPS_DIAGNOSTIC_TOKEN` on `trading-live` (Infisical prod / `.env.local`) — **done 2026-06-29**
3. Restart pm2 `trading` (required after Infisical change so `start:secrets` reloads env)
4. Merge PR #249 and deploy release to `trading-live`
5. Probe:
   ```bash
   curl -sS -H "x-ops-token: $OPS_DIAGNOSTIC_TOKEN" \
     "https://socratictrade.com/api/ops/snapshot?runs=15&audit=30" | jq .
   ```
6. Cursor Cloud runtime secret `OPS_DIAGNOSTIC_TOKEN` — **done 2026-06-29** (start a **new** agent session so it is injected into the shell).

## Cursor Cloud automatic fetch

1. Cursor Dashboard -> **Cloud Agents** -> **Secrets**
2. Add **Runtime Secret**:
   - Name: `OPS_DIAGNOSTIC_TOKEN`
   - Value: same token as production
   - Scope: this repository (or team-wide)
3. Cloud agents will receive it as an env var (redacted in chat). Agents run:
   ```bash
   bash scripts/fetch-prod-ops-snapshot.sh
   # or: npm run ops:snapshot
   ```
4. Rule `.cursor/rules/ops-diagnostics.mdc` + `AGENTS.md` instruct agents to fetch before diagnosing prod issues.

## Follow-ups
- Fix `getAlpacaGateway` to use the run target's connected account (multi-account scheduler bug).
- Add account column to dashboard Runs tab once broker fix lands.
