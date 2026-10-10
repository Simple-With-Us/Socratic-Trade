# 2026-10-10 - Infisical environment selection is prod-only

Board `11df8f1b`.  Branch `claude/infisical-prod-only`.

## 1. Context & Objective

Owner 2026-10-10:  the Infisical `dev` and `staging` environments are being retired and prod is the only environment the fleet reads.  The copy step already moved the keys the apps need into prod.  This change makes every script and code path that picks an environment pick `prod` and refuse anything else, so nothing can read or write a retired environment.  Environment selection only:  no trading, flag or risk-policy logic changed.

## 2. Changes Made

- `scripts/infisical-secrets-safe.sh`:  the `infisical` CLI defaults to `--env dev`, so a `has`, `set` or `names` call without `--env` read dev and could report a prod secret as missing.  `set`, `has` and `names` now add `--env prod` when none is given, and every command refuses any other value (`--env X`, `--env=X`, empty, trailing, or a second `--env`) before the CLI runs.  `delete` never defaults:  it needs an explicit `--env prod`, otherwise `delete KEY` would silently move from deleting in dev to deleting in prod.  That is stricter than the owner's "reject non-prod" rule, on purpose.
- `.cursor/infisical.env`:  `INFISICAL_ENV=dev` became `prod`.
- `scripts/infisical-run.mjs` (the boot runner):  refuses a non-prod `INFISICAL_ENV` or `INFISICAL_SHARED_ENV` with exit 2 before any Infisical CLI call.
- `src/lib/infisical-settings.ts`:  `requireProdEnvironment()` checks the app and shared environments inside the credentialed-init `try`, so a stray value takes the existing loud, fail-soft path (boot-env snapshot) instead of reaching Infisical.
- `scripts/infisical-prod-cutover.sh` and `scripts/sync-provider-knobs.sh` (both remote reads and the apply path):  refuse a non-prod `INFISICAL_ENV`.
- `INFISICAL.md`:  states prod is the only environment.
- Tests:  new `test/infisical-secrets-safe.test.ts` (stub `infisical` first on PATH, never the real CLI), runner cases in `test/infisical-bootstrap.test.ts`, and prod-only cases in `test/infisical-settings.test.ts` (its fixtures moved from `"dev"` to `"prod"`).  50 of the new or changed tests fail against the old sources.

## 3. Decisions & Trade-offs

- Live behavior does not change.  Coolify `ST app/worker` already has `INFISICAL_ENV=prod` (checked 2026-10-10), `INFISICAL_SHARED_ENV` and `INFISICAL_PATH` are not set, and production boots through `infisical-run.mjs` (`scripts/coolify-prod-start.sh`).  What changes is local, Cursor and operator runs, which used to read dev.
- The guard in `infisical-run.mjs` sits in the runner, not in `infisical-bootstrap-env.mjs`:  `test/infisical-bootstrap.test.ts` deliberately feeds a non-prod `INFISICAL_ENV` through the global-file boundary to prove it is dropped.
- `production` is refused here (it is not a real Infisical slug).
- Scripts stay ASCII-only in everything added, per the bash 3.2 rule in `AGENTS.md`;  the wrapper uses no `mapfile`, no associative arrays and no case-folding expansions, and the test runs it under `/bin/bash`.
- Merging to `main` auto-deploys `src/`.  The only `src/` change is the credentialed-init guard, which production never reaches (the runner scrubs credentials) and which is fail-soft.

## 4. Verification State

```bash
npx vitest run test/infisical-secrets-safe.test.ts test/infisical-settings.test.ts test/infisical-bootstrap.test.ts   # 106 passed (later 44 in the wrapper file)
npm run lint                  # -> ok
npx tsc --noEmit              # -> ok (after fixing a ProcessEnv NODE_ENV typing error in the new test that CI caught)
npm test                      # -> ok in CI verify-hosted;  local run on a box at load ~200: 9220 passed, 3 unrelated timeouts, all 3 pass when rerun alone
npm run build                 # -> ok
bash -n scripts/infisical-secrets-safe.sh scripts/infisical-prod-cutover.sh scripts/sync-provider-knobs.sh   # -> ok
grep -nP '[^\x00-\x7F]' <added lines>   # -> none
```

## 5. Next Steps & Blockers

- Parent session deletes the `dev` and `staging` environments of the `socratic-trade` Infisical project after the data-side checks in its audit note.  Nothing in this repo reads them any more.
- Six ST dev-only knobs were deliberately left out of prod.  All six are catalogued in `src/lib/server-knobs.ts` with a code default, so nothing reads a missing key:  `R2_USAGE_DAILY_DIGEST` (on), `RAG_VECTOR_WRITE_QDRANT` (on), `SEC_INGEST_DAYTIME_ENABLED` (on), `SEC_INGEST_TASKS_PER_TICK_RTH` (1), `SEC_INGEST_TASKS_PER_TICK_OFF_HOURS` (5), `TRANSCRIPTS_DAYTIME_ENABLED` (on).
- Seven money-path feature flags had a dev value that differs from prod, and prod's value was kept:  `CONGRESS_STREAM_ENABLED`, `RAG_INGEST_BUDGET_ENABLED`, `RAG_PINECONE_WRITE_BUDGET_ENABLED`, `SEC_INGEST_WORKER_ENABLED`, `STREAMS_ALPACA_NEWS_ENABLED`, `STREAMS_ALPACA_PRICE_EVENTS_ENABLED`, `STREAMS_ALPACA_TRADE_UPDATES_ENABLED`.  Local and Cursor runs that used dev now get prod's values for these.  The three `STREAMS_ALPACA_*` flags have a code default of off.

## 6. Zero-Code Findings

None.  Code was changed.
