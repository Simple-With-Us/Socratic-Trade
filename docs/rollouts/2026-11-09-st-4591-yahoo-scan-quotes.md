# ST-4591 — Harden Yahoo scan quotes (v7 auth + batch abort)

## Context & Objective

Production market scans were emptying when Yahoo v7 batch returned 401 (crumb wall) or chunks aborted under proxy pressure, even though the keyless v8 chart endpoint still returned 200.  This change hardens the Yahoo quote path for scan recovery without touching secrets or order placement.

## Changes Made

- Added `src/lib/yahoo-session.ts` — shared cookie/crumb acquisition and cache keyed by egress proxy (pinned on `globalThis`); bounded handshake timeouts; enrichment and v7 batch share one session handshake.
- Added `src/lib/yahoo-schemas.ts` — zod parse at the Yahoo chart/v7 trust boundary.
- `src/lib/yahoo-finance.ts` — v7 batch calls use session auth; skip v7 immediately when handshake fails; per-chunk pacing via `withProviderLimit`, jittered abort retries, abort wave breaker only counts exhausted chunk aborts; chart fallback uses shorter deadline-aware retries; structured JSON telemetry on 401/abort/empty/session skip.
- `src/lib/data-providers.ts` — Yahoo enrichment uses shared session module.
- Tests: `test/yahoo-quote-fallback.test.ts`, `test/yahoo-finance-fundamentals.test.ts`.

## Decisions & Trade-offs

- v7 remains preferred when crumb auth works (richer bid/ask); auth wall or abort pressure yields quickly to the existing bounded chart fallback (#5071) instead of burning 8s × all chunks.
- Did not add Infisical or new Yahoo API keys — session is the same keyless fc.yahoo.com + getcrumb path enrichment already used.

## Verification State

```bash
npx tsc --noEmit
npm run lint
npm test -- test/yahoo-quote-fallback.test.ts test/yahoo-finance-fundamentals.test.ts
```

## Next Steps & Blockers

- Merge after green `verify` CI; confirm Coolify logs show `v7_session_unavailable` / `v7_auth_wall` / `v7_batch_complete` JSON instead of unbounded `batch fetch failed` noise.
