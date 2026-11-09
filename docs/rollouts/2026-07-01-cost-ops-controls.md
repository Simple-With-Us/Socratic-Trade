# 2026-07-01 — Cost / ops-control items (Chat G, items G8–G9)

## Summary

Implemented the cost/ops-control items from the 2026-07-01 audit work-split
(`docs/reviews/2026-07-01-audit-work-split.md`, Chat G, items 8–9):

- **G8(a)** — Hard per-user/day LLM token/cost budget ceiling, checked at the
  event-driven trigger entry (`src/lib/triggers.ts`, `fire()`, just before
  `runStrategyOnce`). Default OFF — both `TRIGGER_LLM_DAILY_TOKEN_BUDGET` and
  `TRIGGER_LLM_DAILY_COST_BUDGET_USD` are unset by default, so existing behavior
  is unchanged until an operator opts in.
- **G8(b)** — In-process LRU cache for **query** embeddings in
  `src/lib/vector-db.ts` (`retrieveContextDetailed`), keyed by normalized query
  text. Document/upsert embeddings are never cached. Default ON, 128 entries,
  disable with `VECTOR_QUERY_EMBED_CACHE=off` or size 0.
- **G9(a)** — Confirmed Litestream **restore** has never actually been
  exercised (only replication is verified live). Documented the gap and added
  a restore-verification runbook to `docs/litestream.md`, with a status note
  cross-referenced from `docs/ops-observability-security.md`. No infra change.
- **G9(b)** — Cross-checked `DELETE_TABLES_BY_USER_ID`
  (`src/lib/account-deletion.ts`) against the actual, fully-migrated runtime
  schema (not just `CREATE TABLE` statements — several tables gain `user_id`
  via a later `ALTER TABLE` in `db.ts`'s `migrate()`). Found **four**
  user-scoped tables missing from the deletion list — `api_health_log`,
  `mobile_commands`, `rag_usage`, `take_profit_trims` — and added them. Added a
  runtime regression test that fails if a future user-scoped table is added
  without updating the deletion list.

## Why

Per-user cost runaway (an LLM loop or trigger storm burning tokens with no
ceiling) and repeated identical-query embedding spend were both flagged as
open cost-control gaps in the 2026-06-30 improvement audit. Separately, an
account-deletion path that silently leaves user data in an un-swept table is a
privacy/compliance gap that only shows up when a new `db-*.ts` table is added
and the deletion list isn't updated in lockstep — worth a standing regression
test, not just a one-time fix. Litestream restore being "documented but never
run" is a classic DR trap: replication succeeding proves nothing about
recovery working.

## Files

- `src/lib/triggers.ts` — G8(a): `checkLlmDailyBudget()` (exported, pure —
  sums today's usage via `getLlmUsageSummary` from `llm-usage.ts`, day
  boundary via `startOfDayInTimeZone`/`DAILY_RESET_TIME_ZONE` re-exported from
  `db.ts`), wired into `fire()` before `runStrategyOnce`; emits
  `trigger_suppressed_budget` audit event on skip. New env config:
  `TRIGGER_LLM_DAILY_TOKEN_BUDGET` (tokens/day, default unset = no limit) and
  `TRIGGER_LLM_DAILY_COST_BUDGET_USD` (USD/day, default unset = no limit).
- `src/lib/vector-db.ts` — G8(b): `embedQueryCached()` wraps the existing
  `embedWithRetry(voyage, [query], "query")` call inside
  `retrieveContextDetailed` with a per-Voyage-client bounded LRU
  (`Map`-based, insertion-order eviction). New helpers:
  `normalizeQueryCacheKey()` (exported), `clearQueryEmbedCache()`
  (test-only, exported). New env config: `VECTOR_QUERY_EMBED_CACHE` (default
  on) and `VECTOR_QUERY_EMBED_CACHE_SIZE` (default 128).
- `src/lib/account-deletion.ts` — G9(b): added `api_health_log`,
  `mobile_commands`, `rag_usage`, `take_profit_trims` to
  `DELETE_TABLES_BY_USER_ID`; added `DELETE_TABLES_BY_USER_ID_FOR_TEST`
  (exported read-only view for the coverage test, not new public API surface).
- `docs/litestream.md` — G9(a): new "Restore verification status" section
  recording that restore is unverified, plus a runbook/drill procedure.
- `docs/ops-observability-security.md` — G9(a): status cross-reference note
  next to the existing "Periodically verify a restore..." line.
- `test/token-budget-ceiling.test.ts` — NEW. Covers `checkLlmDailyBudget`
  directly (default-off no-op, token-over-budget skip, cost-over-budget skip,
  under-budget no-skip, per-user isolation, day-boundary isolation) and an
  end-to-end `submitMaterialEvent` → `fire()` path with `runStrategyOnce` and
  `isRunAllowedNow` mocked, proving the default-off case still fires and the
  over-budget case is skipped + audited (`trigger_suppressed_budget`).
- `test/query-embedding-cache.test.ts` — NEW. Covers cache-hit on repeated
  identical query, whitespace/casing normalization, cache-miss on a different
  query, document-embeddings-never-cached, `VECTOR_QUERY_EMBED_CACHE=off`
  disables it, and LRU eviction at a configured size.
- `test/account-deletion-coverage.test.ts` — NEW. Queries `sqlite_master` +
  `PRAGMA table_info` against a freshly-migrated temp DB and asserts every
  `user_id`-bearing table is either in `DELETE_TABLES_BY_USER_ID` or in the
  documented outside-the-loop allowlist (`learned_context`,
  `account_deletion_requests`); also asserts every listed table actually
  exists and has `user_id` (catches stale/renamed entries). Verified this
  test fails correctly by temporarily removing/renaming an entry and
  confirming both assertions catch it, then restored.
- `docs/rollouts/2026-07-01-cost-ops-controls.md` — this note.

## Verification

Ran only the targeted test files (per the multi-agent coordination
constraints — no project-wide `npm run build` / `npx tsc --noEmit` / bare
`npm test`, since three other agents were concurrently editing disjoint files
in the same working tree):

```bash
npx vitest run test/token-budget-ceiling.test.ts        # 9 passed
npx vitest run test/query-embedding-cache.test.ts        # 7 passed
npx vitest run test/account-deletion-coverage.test.ts    # 2 passed

# Pre-existing suites touching the same files/areas, re-run to confirm no regressions:
npx vitest run test/triggers.test.ts                      # 6 passed (unchanged)
npx vitest run test/account-deletion.test.ts               # 2 passed (unchanged)
npx vitest run test/vector-db.test.ts test/vector-db-provenance.test.ts \
  test/vector-db-retrieval.test.ts test/vector-db-scope.test.ts \
  test/vector-db-hybrid.test.ts                             # 62 passed (unchanged)
npx vitest run test/mobile-api.test.ts                      # 5 passed (unchanged, exercises account-deletion)
```

All 11 files / 93 tests green. The environment's `node_modules` was initially
missing entirely and `npm install` failed on the private
`@jaywedgeworth22/congress-trading-shared` GitHub Packages dependency
(401 Unauthorized — no registry credentials available in this sandbox); worked
around it with a local install-only stub package (not used by any file in
this workstream's scope, confirmed via `grep -rl "congress-trading-shared"
src app`) so `npm install` could complete and `vitest` become available. No
project files were changed to work around this.

Did **not** run `npm run lint`, `npx tsc --noEmit` (project-wide), `npm test`
(full suite), or `npm run build` — per this task's explicit "orchestrator runs
the final verify quartet" instruction, since three sibling agents were
concurrently editing other files in the same tree.

## Litestream restore status (G9a finding)

**Untested.** Only `litestream databases` / `litestream ltx` (replication
health) were verified live in production per
`docs/rollouts/2026-06-21-litestream-r2-live.md`; that note's own follow-ups
flagged "Consider a periodic restore drill" and it was never closed out — no
rollout note records `scripts/litestream-restore.sh` having actually been run
and its output checked. This is a production-host-only operation (needs real
R2 credentials + `~/apps/trading-live`), out of reach for this sandboxed
agent. Added a documented runbook (`docs/litestream.md` → "Restore
verification status") for the owner/operator to run and log against; no infra
or code change was made or needed.

## Account-deletion coverage (G9b finding)

**Was incomplete.** Four user-scoped tables were missing from
`DELETE_TABLES_BY_USER_ID`: `api_health_log` (per-user API health/error rows,
gains `user_id` via `ALTER TABLE` in `db.ts` migrate()), `mobile_commands`
(mobile app command queue/results), `rag_usage` (per-user RAG
embed/rerank/query cost ledger — the `rag_usage` analogue of the already
handled `llm_usage`), and `take_profit_trims` (per-user/account/symbol
take-profit ratchet state, same family as the already-handled
`synthetic_trailing_stops`/`broker_protective_stops`). All four are now
included, and the new `test/account-deletion-coverage.test.ts` will fail the
build if a future new user-scoped table is added without a matching update
here — verified this by temporarily breaking the list and confirming the test
catches it.

## Follow-ups / integration risk

- **G8(a)** only guards the **event-driven** trigger path
  (`triggers.ts`'s `fire()`). The **interval-based** scheduler
  (`src/lib/scheduler.ts`) also calls `runStrategyOnce` directly and is owned
  by a different area of the codebase — per this task's scope
  (`triggers.ts` only, do not edit `strategy.ts`), the budget check was not
  wired into the interval path. `checkLlmDailyBudget` is exported from
  `triggers.ts` specifically so a follow-up can call it from
  `scheduler.ts`'s interval loop too, if the operator wants the ceiling to
  apply regardless of trigger mode. Until then, a user running only the
  interval scheduler (the default — `TRIGGER_ENGINE` is off by default) has
  **no** budget ceiling regardless of the new env vars. This is a known,
  intentional scope boundary, not an oversight — flagging it so it isn't lost.
- **G8(a)** cost/token totals are read fresh from the ledger on every `fire()`
  call (`getLlmUsageSummary` does a `GROUP BY` scan with a `sinceIso` filter,
  no caching). Fine at current usage-table volume; revisit if `llm_usage`
  grows large enough that this becomes a hot-path cost of its own.
  `getLlmUsageSummary` is read-only (`llm-usage.ts` is explicitly READ-ONLY
  for this workstream), so no schema/index change was made here — if this
  needs to scale, an index on `(user_id, created_at)` would help (check
  whether one already exists before adding).
- **G8(b)** cache is per-process (module-level `Map`), not shared across
  server instances/restarts — fine for a single-node deployment (matches the
  rest of this repo's SQLite/single-node posture) but would not help in a
  multi-instance deployment without a shared cache layer.
- **G9(a)** remains a real open risk until an operator actually runs the
  drill on `trading-live` and records the result — this PR only makes the gap
  visible and gives a runbook, it does not close the gap itself.

## Scope note

Per this task's coordination rules, only files under
`src/lib/triggers.ts`, `src/lib/vector-db.ts`, `src/lib/account-deletion.ts`,
`docs/litestream.md`, `docs/ops-observability-security.md`, and the new test
files above were touched. `src/lib/strategy.ts`, `src/lib/llm-usage.ts`,
`src/lib/scheduler.ts`, `src/lib/db.ts`, and all other sibling-owned files
were read-only references, not edited.
