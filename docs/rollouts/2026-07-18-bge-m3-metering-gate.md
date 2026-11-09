# 2026-07-18 - bge-m3-metering-gate

## Summary

Metering/gating half of the bge-m3 embedding migration (branch `claude/bge-m3-metering-gate`).
Three changes:

1. **Provider-aware RAG metering (live-bug fix).** `meterEmbed`/`meterRerank`
   (`src/lib/rag-metering.ts`) hardcoded `provider: "voyage"` on every `rag_usage` row, and
   `estimateVoyageDispatchCost` hardcoded Voyage pricing — so bge-m3 calls served by
   OpenRouter/SiliconFlow were booked as Voyage spend at Voyage prices. Both now take an explicit
   `provider` argument (`RagEmbedRerankProvider = "voyage" | "openrouter" | "siliconflow"`,
   default `"voyage"` so untouched callers behave identically), an OpenRouter price branch was
   added to `estimateRagCost`, and every embed/rerank call site in `src/lib/vector-db.ts` threads
   the ACTIVE provider through (new `activeEmbeddingProvider()`/`activeRerankProvider()` helpers,
   which are now also the single routing truth inside `embedWithRetry`/`rerankMatches`).
   Consequential consumer fix: `remainingIngestTexts` (the `RAG_INGEST_MAX_TEXTS_PER_DAY`
   enforcement in vector-db.ts) filtered `rag_usage` on `provider === "voyage"` — with rows now
   carrying the true provider, that filter would have stopped counting the moment a non-Voyage
   provider went active, so it now counts embeds across all providers. The `llm-budget.ts` daily
   ceiling consumers sum `rag_usage` without provider filters and needed no change.

2. **Explicit embed-provider gate `RAG_EMBED_PROVIDER`.** New env (`voyage` | `openrouter` |
   `siliconflow`). Unset (default): key-presence precedence is preserved byte-for-byte
   (OpenRouter key wins, then SiliconFlow, then Voyage) — nothing changes until the owner opts
   in. Set: pins BOTH `activeEmbeddingModel`/`activeRerankModel` provider selection AND the
   dispatch routing; a pinned-but-keyless provider throws loudly at embed time instead of
   silently falling back into the wrong embedding space. Documented in `.env.example` together
   with `OPENROUTER_API_KEY`/`SILICONFLOW_API_KEY` (previously undocumented for RAG) including
   the coupling warning that a bare `OPENROUTER_API_KEY` flips RAG embeddings as a side effect.

3. **Provider-aware /api/health voyage probe (prod 503 fix).** `app/api/health/route.ts` treated
   the `voyage`/`voyage-rerank` health lanes as hard-critical (503 on >=5 consecutive failures)
   unconditionally. With prod live on bge-m3 (see Deployment status below) the dead Voyage lane
   was 503ing the whole app for a provider it no longer calls. Criticality is now gated on
   `activeEmbeddingProvider() === "voyage"`; the lanes are still *reported* in
   `checks.dependencies` either way, the route now also reports `checks.ragEmbedProvider`, and
   `ragConfigured` is computed against the ACTIVE provider's key (not always Voyage's). A
   pinned-but-keyless `RAG_EMBED_PROVIDER` is surfaced as `ragEmbedProviderError` +
   `ragConfigured:false` without 503ing (a 503 would restart-loop the container on a pure config
   error).

## Deployment status / sequencing — READ THIS FIRST

**The bge-m3 flip is ALREADY LIVE in production.** Prod has `OPENROUTER_API_KEY` set and the
flip deployed on the morning of 2026-07-18 (auto-deploy on merge to main). Consequences until
this lane lands:

- Every prod bge-m3 embed/rerank is being metered as `provider='voyage'` at Voyage prices
  (~12x overstatement for embeds: $0.12/1M booked vs $0.01/1M real).
- `/api/health` returns 503 (voyage lane hard-stopped, `ok:false`) — external uptime tooling
  sees the app as down and the container can be restart-looped.

**This lane should therefore land ASAP** — it is a production-observability/accounting fix for
a state prod is already in, not a preparatory change. (The original sequencing note — "deploy
before or with the first deploy that flips embeddings" — is moot; the flip won the race.)

## Price constants used (with sources)

| Provider | Model | Operation | Constant | Source |
| --- | --- | --- | --- | --- |
| OpenRouter | `baai/bge-m3` | embed | $0.00001 / 1K tokens ($0.01 / 1M) | openrouter.ai/baai/bge-m3/pricing (confirmed 2026-07-18) |
| OpenRouter | `cohere/rerank-v3.5` | rerank | $0.001 per search (1 query + up to 100 docs = 1 search) | openrouter.ai/cohere/rerank-v3.5 (confirmed 2026-07-18) |
| SiliconFlow | `BAAI/bge-m3` | embed | $0.00001 / 1K tokens | pre-existing table (unchanged) |
| Voyage | `voyage-finance-2` etc. | embed/rerank | pre-existing table (unchanged) | rag-metering.ts header note |

OpenRouter rerank caveat (documented in the code comment): OpenRouter prices rerank **per
search**, not per token; docs >500 tokens auto-chunk into extra searches, which the ledger's
aggregate token count cannot model — the estimate models `ceil(documents/100)` searches only and
can undercount for unusually long documents. Good enough for the $/day dispatch fuse and
dashboards; reconcile against the OpenRouter dashboard for billing-grade numbers. Unknown models
under openrouter/siliconflow estimate at that provider's bge-m3/known-table rate — never
cross-attributed to Voyage pricing; the Voyage fallback row only applies within
`provider="voyage"`.

## Why

- The metering bug was live the moment prod's `OPENROUTER_API_KEY` landed: cost attribution,
  the per-user daily LLM/RAG ceiling, and the provider dispatch cost fuse were all being fed
  Voyage-priced rows for OpenRouter traffic.
- Key-presence-as-routing is a footgun (setting an LLM key silently migrates the embedding
  space); the owner needs an explicit pin with loud failure semantics.
- The health probe 503 makes prod look down to uptime tooling and risks restart loops while
  the app is actually fine on bge-m3.

## Files

- `src/lib/rag-metering.ts` — `RagEmbedRerankProvider` type; OpenRouter price tables + branch in
  `estimateRagCost` (now takes `batchCount` for per-search rerank pricing); `provider` params on
  `estimateVoyageDispatchCost`/`meterEmbed`/`meterRerank` (default `"voyage"`).
- `src/lib/vector-db.ts` — `RAG_EMBED_PROVIDER` pin (`pinnedEmbedProvider`,
  `assertPinnedProviderKeyConfigured`, `resolveActiveRagProvider`); new exported
  `activeEmbeddingProvider`/`activeRerankProvider`; `activeEmbeddingModel`/`activeRerankModel`
  now derive from them; `embedWithRetry`/`rerankMatches` route + estimate + meter by the active
  provider; `remainingIngestTexts` counts embeds across providers; ingest-budget alert + Sentry
  breadcrumbs report the active provider.
- `app/api/health/route.ts` — provider-aware voyage criticality + `ragEmbedProvider`/
  `ragEmbedProviderError` fields + active-provider-aware `ragConfigured`.
- `.env.example` — `OPENROUTER_API_KEY`, `SILICONFLOW_API_KEY`, `RAG_EMBED_PROVIDER` documented
  in the RAG section.
- `test/rag-metering.test.ts` — provider-aware metering rows (openrouter stamps + bge-m3 price,
  per-search rerank price, voyage default unchanged).
- `test/rag-embed-provider-gate.test.ts` — NEW: unset-precedence, pin-overrides-keys,
  pinned-but-keyless loud error (both selectors + both model fns), invalid-value error.
- `test/connection-health-routing.test.ts` — NEW cases: hard-stopped voyage lane with OpenRouter
  active stays 200 (still reported failed), with Voyage active still 503s, pinned-but-keyless
  stays 200 with `ragEmbedProviderError`.
- `docs/rollouts/2026-07-18-bge-m3-metering-gate.md` — this note.

## Verification

Environment note: shared Mac; earlier runs happened under heavy multi-agent load (load avg
~50-60 on 10 cores) and a mid-session machine reboot — long wall-clock times were contention,
not test cost. All commands under `PATH=/opt/homebrew/opt/node@24/bin:$PATH` (node 24, per the
node26 ABI trap).

- `npx tsc --noEmit` — **clean (0 errors)**, final run includes the health-route and test
  changes.
- `npx vitest run test/rag-metering.test.ts test/rag-embed-provider-gate.test.ts
  test/embedding-space-isolation.test.ts test/vector-db-voyage-dispatch-cost.test.ts
  test/query-embedding-cache.test.ts test/vector-db.test.ts
  test/connection-health-routing.test.ts test/trading-liveness.test.ts
  test/llm-budget-enforcement.test.ts test/usage-budget.test.ts` — **10 files, 117/117
  passed** (embedding-space-isolation stays green; dispatch-cost suite proves the reservation
  still carries a real non-zero estimate; the 3 new health-route cases pass alongside the
  pre-existing 200/503 criticality cases).
- `npx vitest run test/usage-budget-strategy-integration.test.ts` — **5/5 passed** on this
  branch. This file failed 2/5 twice during the load-avg-~50 spike (a 90s timeout + a cascade
  assertion); an A/B run on the base commit (2aa53e15, pristine worktree, same node_modules)
  and a same-conditions branch re-run after the reboot both pass 5/5 — confirmed
  machine-contention flake, not this diff (the file mocks `../src/lib/vector-db` entirely).
- `npm run build` intentionally NOT run (out of scope per lane instructions; `verify` CI runs it
  on the PR).

## Follow-ups

- **Health-lane naming:** RAG embed/rerank failures are still LOGGED under the historical
  `voyage`/`voyage-rerank` service names in `api_health_log` regardless of the serving provider
  (`withRagApiHealth` call sites). While a non-Voyage provider is active, a genuine embed outage
  therefore degrades `/api/health` rather than 503ing it. Renaming those lanes per-provider
  (touches `RAG_SERVICES_WITH_OWN_ALERTING` in db-health.ts, alerting, admin connections UI) is
  a deliberate follow-up.
- **OpenRouter rerank auto-chunk undercount** (>500-token docs) — see price-constant caveat.
- **SiliconFlow `Qwen/Qwen3-Reranker-8B` rerank price** remains the pre-existing nominal
  $0.00005/1K estimate — verify against SiliconFlow's price sheet if that lane ever goes active.
- **Owner decision:** consider setting `RAG_EMBED_PROVIDER=openrouter` in Infisical to make
  prod's current state explicit rather than key-presence-implied.

## Risks

- `meterEmbed`/`meterRerank`/`estimateVoyageDispatchCost` keep `provider` OPTIONAL (default
  voyage) — a future call site that forgets to pass it reverts that row to the old bug silently.
  Acceptable to keep signatures compatible for this fix; a follow-up could make it required.
- The ingest-budget filter change (`provider === "voyage"` dropped) means pre-existing
  mixed-provider ledgers now count ALL embed rows toward `RAG_INGEST_MAX_TEXTS_PER_DAY` — this
  is the correct behavior but can make the cap bind slightly earlier on the flip day itself.
- Health route: while a non-Voyage provider is active, hard embed failures no longer 503 (see
  follow-up on lane naming).

## Landing-pass addendum (2026-07-18, later same day)

**This fix was already absorbed into `main` before this branch's own PR opened, via an unrelated
PR.** While gating this branch for landing, `origin/main@d9527cde` (PR #1762, "antigravity/effort
log update july18", squash-merged from branch `antigravity/effort-log-update-july18`) turned out
to already contain byte-identical copies of every code/test file this branch touches
(`src/lib/rag-metering.ts`, `app/api/health/route.ts`, `test/rag-metering.test.ts`,
`test/rag-embed-provider-gate.test.ts`, `test/connection-health-routing.test.ts` all diff to
zero bytes against this branch's HEAD; `src/lib/vector-db.ts`/`.env.example` differ only by
strictly-additive content main gained from other lanes afterward). Root cause: this repo's
worktrees share one local object store, and `git branch -a --contains 39ca9ad6` shows this
branch's exact commit is also reachable from local branches `agent/ag-reindex-bge-m3` and
`antigravity/effort-log-update-july18` — another agent merged/cherry-picked this exact commit
object into their own branch (without ever pushing `claude/bge-m3-metering-gate` to origin) before
squash-landing it as part of a larger, differently-scoped PR. `curl https://socratictrade.com/api/health`
at landing time confirms `release.sha == d9527cde` and `ok:true` (voyage lane no longer 503ing) —
the metering/health fix described above is **already live in production**, independent of this
PR's merge.

Consequence for this landing: merging this branch is a functional no-op for production (main
already has the fix); the PR exists to formally close the loop — land the rollout note/effort-log
history for this work and pick up the genuinely-new stale-overlap-guard-flagged deltas (main's
additive `vector-db.ts` `purgeManagedVectorsByIds` export and `.env.example` SEC-ingest/
server-metrics doc blocks) via the merge. `LAND_ALLOW_STALE_OVERLAP=1` was used for
`scripts/land.sh` after this manual review confirmed zero real conflict (verified via direct
`diff` of every overlapping file, not assumed).
