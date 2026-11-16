# 2026-07-07 — Per-account/broker LLM usage attribution (Monet)

## Summary

LLM usage/cost is now trackable and filterable **per connected account/broker**, not just per
user/provider/key. Every `recordLlmUsage` call can tag the connected account it was made for; the
usage summary derives broker/environment/label via a join and gains account + broker filters; the
usage APIs and the shared usage UI expose those dimensions.

## Why

Owner request: "llm usage should be filterable/trackable somehow per account/broker also." The agent
loop already runs per-account (`runStrategy` threads `connectedAccountId`, and LLM *budgets* are
per-account), but the `llm_usage` ledger stored no account — so historical cost/tokens could not be
attributed or filtered by the account the work was done for. This closes that gap.

**Scope decisions (owner asked "what makes the most logical sense"):**
- **Tracking now, local-only.** The account/broker dimension lives in Socratic's own `llm_usage`. The
  external API-usage-monitor push (`usage-monitor-push.ts`) is intentionally **untouched** — it is a
  cross-app aggregate-cost sink and "account" is a Socratic-only concept (would bloat the shared schema
  + steps on Claude's telemetry lane).
- **Budget enforcement UNCHANGED.** `checkLlmDailyBudget` still measures global spend against
  per-account limits. Making it per-account is a *cost-policy fork* (a per-account cap can raise total
  spend by #accounts) — deferred to the owner now that per-account spend is visible. Not a silent
  behavior change.

## Files

- `src/lib/db.ts` — migration **14** `llm_usage_connected_account`: `ALTER TABLE llm_usage ADD COLUMN
  connected_account_id TEXT` + index `idx_llm_usage_account`. Versioned ALTER only (the baseline
  `CREATE TABLE` is deliberately **not** touched — migration-era columns there crash boot on
  pre-existing DBs, the documented 2026-07-02 incident; matches how `key_ref` is handled).
- `src/lib/llm-usage.ts` — `LlmUsageEntry.connectedAccountId?`; INSERT writes it; `LlmUsageRow` gains
  `connectedAccountId`/`broker`/`environment`/`accountLabel`; `getLlmUsageSummary` LEFT-JOINs
  `connected_accounts` (broker/env/label derived, null = unattributed) and adds `connectedAccountId` +
  `broker` filter options.
- `src/lib/{post-mortem,outcome-engine,proposal-revalidation,strategy-tuning}.ts` — thread
  `connectedAccountId: policy.connectedAccountId` into `recordLlmUsage` (each site already resolves the
  `policy` whose account key made the call, so this is the semantically correct attribution).
- `app/api/llm-usage/route.ts`, `app/api/admin/llm-usage/route.ts` — accept `?accountId=` / `?broker=`.
- `app/admin/llm-usage/llm-usage-client.tsx` (shared by `/console/usage` + `/admin/llm-usage`) — group
  cards per account, account badge, account filter dropdown, filtered summary; account-less rows read
  "Unattributed".
- `test/llm-usage-per-account.test.ts` — new: attribution, broker join, both filters, honest-null.
- `STATUS.md`, `docs/EFFORT-LOG.md` — updated.

## Verification

- `npx tsc --noEmit` → **0 errors**.
- `npx vitest run` → **2875 passed** (284 files), incl. the 4 new tests; no regressions from the
  `getLlmUsageSummary` query rewrite (aliased `lu.` + LEFT JOIN).
- `npm run build` → exit 0.
- `npx eslint <touched files>` → **0 errors** (7 pre-existing grandfathered warnings, none introduced).
- Built in a throwaway worktree `~/apps/trading-monet-llmusage` off `origin/main` (790b5f52) because
  the primary tree was dirty with the in-flight single-adversary consolidation.

## Follow-ups

- **`strategy` / `strategy-bear` (`strategy.ts`) + `red-team.ts`** attribution is deferred — those
  files are CLAUDE-Cowork's active single-adversary-consolidation keepout. Those contexts currently
  record `connected_account_id = NULL` ("Unattributed"). The fix is a one-liner per site
  (`connectedAccountId: policy.connectedAccountId`); flagged on #ag***-s**c for Claude to add as it
  consolidates, or for Monet to thread once that work lands.
- **Budget policy fork** (owner): decide global vs per-account LLM daily cap now that per-account spend
  is visible. One-line change in `llm-budget.ts` (add `lu.connected_account_id = ?` to the spend SUM).
- Pre-existing rows and account-less contexts stay `NULL` — no backfill (usage wasn't tied to an
  account historically; attempting to reconstruct it would be guesswork).
