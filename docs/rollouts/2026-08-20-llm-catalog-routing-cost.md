# 2026-08-20 — Model choice, receipts and cost now derive from live truth instead of a stale table

## Context & Objective
Review cluster `llm-catalog-routing-cost` (`docs/reviews/2026-08-18-full-app-expert-review.md`).  Five defects, all confirmed against code before fixing.  All five are addressed.

## The review's prescribed fix was WRONG, and was not implemented

The review says OpenRouter returns exact billed credits when the request body includes `usage: { include: true }`, and prescribes adding that field in `buildLlmRequestBody`.

**That parameter is deprecated and inert.**  OpenRouter's current documentation, under *Usage Information*: the `usage: { include: true }` and `stream_options: { include_usage: true }` parameters are deprecated and have no effect, because full usage details are now always included automatically in every response.

So it was deliberately **not** added.  Adding a deprecated field to every OpenRouter request body would be dead weight, and non-trivially risky here: `applyOpenRouterProviderRouting` sets `require_parameters: true` for OpenAI reasoning models, which filters endpoints by advertised request fields — an unknown field there is exactly the class of thing that produced the documented 404 storm (`llm-call.ts:139-158`).

The fix is purely **read-side**: `usage.cost` was already arriving on every OpenRouter response and being thrown away.  Everything downstream of the review's recommendation still holds.

## The number that matters

On 100k in / 20k out of `claude-opus-5`, the hand-maintained price table says **$1.00** where the transport actually billed **$0.25** — a **4× overstatement on a single call**.  `/console/usage` was derived entirely from that table, with no embedding or rerank row at all.

## Changes Made

| Defect | Files |
|---|---|
| (4) billed cost is now stored and shown | `src/lib/llm-usage.ts`, `src/lib/db.ts` (migration 86), `app/api/llm-usage/route.ts`, `app/api/admin/llm-usage/route.ts`, `app/admin/llm-usage/llm-usage-client.tsx` |
| (4) late post-soft-timeout replies are metered, not just audited | **new** `src/lib/llm-late-usage.ts`, `src/lib/strategy.ts`, `src/lib/red-team.ts` |
| (2) the receipt stops asserting "not a failover" when a fallback answered | `src/lib/types.ts`, `src/lib/strategy.ts`, `app/console/components/approval-card.tsx` |
| (1) rotation reads the live catalog instead of a hardcoded dead list | `src/lib/model-rotation.ts`, `src/lib/openrouter-model-availability.ts`, wire-up in `strategy.ts` / `red-team.ts` |
| (5) Red Team payload compacted to the documented subset | `src/lib/red-team.ts`, `src/lib/strategy.ts` |
| (3) Coach routing | `src/lib/chat/llm.ts`, `app/api/chat/providers/route.ts` |

New tests: `llm-billed-cost`, `approval-card-fallback-receipt`, `red-team-context-projection`, `model-rotation-live-catalog`, `chat-openrouter-routing`.

## Decisions & Trade-offs

**Only OpenRouter is trusted to define money.**  `recordLlmUsage` gates billed cost on `provider === "openrouter"`.  `extractLlmUsage` will surface any `usage.cost`, but a number from another transport is not treated as authoritative.  A billed `0` is honoured (free and promotional models are real); a negative value is dropped.

**Billed and estimated are never silently mixed.**  New `cost_source` column (`billed` / `estimated`; NULL on legacy rows means estimated, because that is what those rows were).  `getLlmUsageSummary` returns `billedCostUsd` / `estimatedCostUsd` / `billedCalls` / `estimatedCalls` as separate sums.  The Usage tile reads `$X billed + $Y estimated` when mixed and never presents the total as billed truth; estimated line items carry an explanatory footnote.  No "mock" / "fallback" / "demo" wording anywhere, per the repo rule.

**Red Team compaction keeps `evidenceManifest`.**  It was added to `RedTeamReviewContext` because the run-time review has always sent it, and `greenRedParityHash` is what actually proves both stages judged one evidence pack.  `test/strategy-prompt-safety.test.ts` asserts manifest equality and still passes.  The projection cuts >90% of a realistic Green evidence payload.

**One assertion was written and then dropped, deliberately.**  A "Red payload < Green payload" size check failed (17040 vs 7911) because the Red body legitimately also carries the proposal, quote, policy block and owner strategy prompt — on a small fixture it genuinely exceeds Green.  Replaced with exact key-absence checks, and the size measurement moved to a realistic fixture in the projection test, with a comment explaining why.

## Two problems found that the review did not

**A. A real bug in this change's own migration.**  Migration 86 first used the same `PRAGMA table_info` shape as migrations 2 and 14.  `PRAGMA table_info` on a **missing** table returns an empty list rather than erroring, so the "column absent" branch was taken and the `ALTER` died with `no such table: llm_usage` — 11 failures in `test/persistence-hardening.test.ts`, which deliberately exercises migrations against a database that never saw the baseline schema.  Fixed with the `sqlite_master` guard migration 84 already uses.

**Migrations 2 and 14 carry the same latent shape.**  They survive today only because nothing currently runs them against a schema-less database — an accident of ordering, not a property anyone asserted, and `DB_BOOTSTRAP=fresh` is exactly the path that would expose it.  Filed as issue #2964.

**B. A test-fixture fragility, and a genuine 3-test regression chased to ground.**  `test/strategy-llm-failover.test.ts` mocks branch on `String(init.body).includes("gpt-")` / `.includes("claude")` — a substring of the *entire* serialized payload.  The new `greenServedByFallback.fromModel` receipt legitimately puts the failed primary's model name into the proposal, so the **Red Team** call started matching the **Green** branch, got a 429, parked a provider-cooldown lane, and leaked into the next three tests in the file, which then failed at the Green step with a misleading "Empty response" error.  Bisected to that one line and repaired the fixtures to match on the request's own `model` field — which is what a real provider does.  **No assertion was weakened.**

## Verification State
Failing-first proven per fix, each reverted in place and restored.  Selected real output:

- Billed cost: 8 of 11 failed, including `expected 1 to be 0.25` — the 4× overstatement above.
- Late metering: `a late reply the provider billed must produce a ledger row: expected undefined to be truthy`.
- Honest receipt: `expected 'policy rotates models — the served mo…' not to contain 'not a failover'`.
- Red Team payload: `Red Team must not re-send the Green-only block "marketScan"`.
- Live catalog: `expected [ 'gemini-flash-latest', …(1) ] to include 'claude-fable-5'`.
- Coach routing: `expected MockLLM{ modelName: 'mock' } to be an instance of OpenAILLM`.

Full gate results recorded in the PR.

## Next Steps & Blockers
Issue #2964 (migrations 2 and 14) is unclaimed.

Two modified tests changed assertions that **encoded the old bug as expected behaviour** (`test/model-rotation.test.ts`) — worth a reviewer's eye to confirm the new expectations are the intended ones.
