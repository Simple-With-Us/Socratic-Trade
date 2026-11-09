# 2026-08-09 — Pinecone trial: ingest-throughput audit + monthly write-unit PACE guard

## 1. Context & Objective

Owner directive (2026-08-09): *"Let's make sure we use pinecone close to full extent of trial and
then I will drop down to free or $20 plan."* The owner opened a Pinecone **Standard trial** (the
2M-WU/month write cap is lifted — a live upsert probe returned 200), on top of the reactive
monthly-WU breaker (`src/lib/pinecone-wu-breaker.ts`, PR #2596) and the durable embed stage
(`src/lib/db-embed-stage.ts`, PR #2598) that just landed.

Two halves, both delivered here:

- **A — Throughput audit.** Inventory every limiter between "a filing exists" and "its vectors are
  in Pinecone", with the value to use DURING the trial vs AFTER it. Values are documented here as a
  table for the owner/orchestrator to apply in Infisical. **No secrets were read or written by this
  session.**
- **B — Post-trial safety.** A calendar-month write-unit **pace** guard so a $0/$20 plan degrades
  gracefully instead of hitting the hard hourly-429 wall again.

---

## 2. Changes Made

### 2a. New module: monthly write-unit pace guard

`src/lib/pinecone-monthly-pace.ts` — mirrors `src/lib/r2-usage.ts`'s pace concept (linear month-end
projection with an elapsed-fraction floor) and `pinecone-wu-breaker.ts`'s marker/one-advisory
pattern.

- **Accounting.** A persisted internal-settings row `pinecone:monthWriteUnits` holds
  `{ month: "YYYY-MM", units, updatedAt }`. It is advanced from `meterPineconeUpsert`
  (`src/lib/rag-metering.ts`) — the single post-success call site that already writes the
  `rag_usage` row the rolling-24h fuse reads — so the daily fuse and the monthly counter can never
  disagree about what was delivered. A row from a previous month simply stops counting: the month
  roll IS the reset, no cleanup job.
- **Why a counter and not a `rag_usage` query.** The daily fuse
  (`usedPineconeWriteUnitsLast24h`, `src/lib/vector-db.ts:576`) sums the ledger over 24h. A month
  query would be O(month) on every worker tick and would silently under-report once `rag_usage` is
  pruned. One row, O(1), survives pruning.
- **Projection.** `assessPineconeWuPace({ mtd, budget, now })` → projected month-end =
  `mtd / max(elapsedFraction, 0.2)`. The 0.2 floor is copied from `R2_OPS_PACE_ELAPSED_FLOOR` for
  the same reason (a burst on the 1st would otherwise project at 200x). `exceeded` is
  `projected > budget || mtd >= budget` — the projection catches a runaway trend early, the
  absolute check catches a month that is already spent (where a late-month projection can dip back
  under 100%).
- **Config.** `PINECONE_MONTHLY_WU_BUDGET`, **default 0 = OFF**. With no budget set, nothing is
  throttled and only the month-to-date counter accrues.
- **Lane scoping.** `pineconeBackfillPaceGate(lane)` returns `throttled: true` only for
  `lane: "backfill"`. `"incremental"` and `"retrieval"` are structurally incapable of being
  throttled — the check returns before any assessment. Wired into
  `SecIngestWorker.runTick()` (`src/lib/rag/sec-ingest-worker.ts`), which IS the bulk/backfill lane:
  when throttled it stops **claiming new tasks**; already-leased tasks, the scheduled
  `refreshFilingBodies` incremental lane, and all retrieval are untouched.
- **Advisory.** One `storage_warning` (`pinecone_monthly_wu_pace`) + one
  `pinecone_wu_pace_throttle` audit row per **calendar month**, watermarked in
  `pinecone:monthWuPaceAdvisedMonth`. Deliberately not cleared on recovery — a metric oscillating
  around the threshold would otherwise re-notify all month.
- **Fails open** on every error path (backfill continues), like every other advisory guard here.

### 2b. Admin surface (one-line addition)

`/api/admin/rag-coverage` → `providerUsage.pinecone.monthlyWriteUnitPace` now carries the full
assessment (`enabled`, `month`, `mtd`, `budget`, `projected`, `pctUsed`, `projectedPct`,
`exceeded`). This is live **even when the budget is off**, because "how many WUs did the trial
actually burn" is exactly the number the owner needs to pick the post-trial plan.

### 2c. Files touched

- `src/lib/pinecone-monthly-pace.ts` (new)
- `src/lib/rag-metering.ts` (`meterPineconeUpsert` advances the month counter)
- `src/lib/rag/sec-ingest-worker.ts` (pace gate at the top of the tick; `runTick` made public so a
  single tick is testable deterministically instead of racing the 5s interval)
- `app/api/admin/rag-coverage/route.ts` (one field)
- `.env.example` (`PINECONE_MONTHLY_WU_BUDGET` documented, default 0)
- `test/pinecone-monthly-pace.test.ts` (new, 10 tests)
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note

---

## 3. Part A — Throughput audit

### 3a. The dominant finding

**`VECTOR_EMBED_BATCH_DELAY_MS` (default 21,000 ms) is applied unconditionally between every embed
batch** — `src/lib/vector-db.ts:3006`, `await sleep(embedBatchDelayMs())`. It is a **Voyage
free-tier (3 RPM) artifact**, and production embeds through **OpenRouter `baai/bge-m3`**, which has
no such limit. At the default batch size of 8, this pins ingest at:

```
8 chunks / 21 s = 0.38 chunks/s = ~1,371 chunks/hour = ~33k chunks/day at 100% duty cycle
```

A single 10-K produces roughly 500–1,000 child chunks, so one filing takes 6–12 minutes of pure
sleeping. Nothing else in the stack is close to this restrictive. **This is the first knob to
change.**

(Note: `isFreeTier()` in `src/lib/web-sources/sec-filings.ts:723` already ignores this env var when
the active provider is not Voyage — so the *filings-per-run* path is provider-aware, but the
*embed pacing* path is not.)

### 3b. Cost model (verify against provider dashboards before relying on it)

| Quantity | Value | Source |
|---|---|---|
| Embed model | `baai/bge-m3` via OpenRouter | `RAG_EMBED_PROVIDER` / key precedence, `.env.example` |
| Embed price | **$0.01 per 1M input tokens** = $0.00001/1K | `OPENROUTER_EMBED_PRICE_PER_1K_TOKENS`, `src/lib/rag-metering.ts:73` |
| Chunk size embedded | child chunks, target ~120–130 tokens (`childMaxTokens = maxTokens/3`, `DEFAULT_MAX_TOKENS = 480`) | `src/lib/rag/chunk.ts:8,268` |
| **Embed cost per 1,000 chunks** | **~$0.0013** (~125k tokens). Even at the 480-token parent size it is only ~$0.005. | derived |
| Pinecone WU per chunk record | **~8 WU** — 4,096 B vector (1024-dim f32) + `text` + `parent_text` + metadata + 512 B overhead, `ceil(bytes/1024)` | `estimatePineconeRecordWriteUnits`, `src/lib/vector-db.ts:593` |
| Managed two-phase commits | **~2x WU** (pending upsert + committed re-upsert) | `applyPineconeWriteBudget` `isManagedCommit`, `src/lib/vector-db.ts:2097` |

**Headline: OpenRouter embed spend is NOT the constraint.** A 250k-chunk day costs ~$0.31. A
full-universe backfill (~1,000 issuers × 5 filings × ~700 chunks ≈ 3.5M chunks) costs roughly
**$4–$5 in OpenRouter embeds** — but **~28M Pinecone write units** and, more importantly,
**~28 GB of Pinecone storage that has to keep living on whatever plan comes after the trial.**

### 3c. What actually spends money disproportionately

1. **Post-trial storage, not writes.** Write units are a one-time cost per record; storage is
   recurring. Index everything now and the free tier (~2 GB, verify in console) holds only
   ~250k records ≈ ~350 filings. **Size the trial backfill to the corpus you intend to KEEP.**
   The scheduler already orders symbols demand-first (holdings → watchlist → last scan's candidate
   set → index universe, `src/lib/scheduler.ts:566-590`) — that ordering is the thing to lean on.
2. **Any embed-provider / model flip after a big backfill.** `embeddingSpaceRevisionForModel`
   isolates embedding spaces, so flipping `RAG_EMBED_PROVIDER` makes the entire existing corpus
   invisible and forces `src/lib/rag/corpus-reembed.ts` to re-embed **and re-upsert** all of it —
   paying both the OpenRouter bill and the WU bill a second time. **Do not change the embed
   provider/model during or right after the trial backfill.**
3. **Rerank on the retrieval side.** `cohere/rerank-v3.5` is **$0.001 per search**, one search per
   100 documents (`src/lib/rag-metering.ts:85-88`). A deeper corpus means deeper candidate pools; a
   1,000-document pool is 10 searches = $0.01 **per retrieval call**. This scales with usage, not
   with corpus size, but a bigger corpus makes each call more expensive. Retrieval spend can quietly
   exceed ingest spend.
4. **Trial credit is billed, not free.** Standard lifts the *cap*; it does not make writes free. Once
   trial credit is exhausted, WUs bill at the plan rate. Check the remaining trial credit in the
   Pinecone console before opening the taps.

### 3d. Recommended knob values — **owner/orchestrator applies these in Infisical; this session did not write any secret**

| Knob | Read at | Current effective default | **TRIAL window** | **AFTER trial (2M-WU plan)** | Why |
|---|---|---|---|---|---|
| `VECTOR_EMBED_BATCH_DELAY_MS` | `vector-db.ts:508`, applied at `:3006` | `21000` | **`0`** | `0` | Voyage-free-tier artifact; irrelevant to OpenRouter bge-m3. Single biggest throughput lever (see 3a). Also shortens embed retry backoff, which takes `max(batchDelay, jittered backoff)` (`:2178`). |
| `VECTOR_EMBED_BATCH_SIZE` | `vector-db.ts:504` (clamped 1–128) | `8` | **`32`** | `16` | Drives BOTH the embed request and the Pinecone upsert batch (`chunks(documentsToStore, embedBatchSize())`, `:3001`). 32 × ~8 KB ≈ 256 KB/upsert — comfortably under Pinecone's 2 MB request limit. `64` (~512 KB) is the aggressive option if no 429s appear. |
| `RAG_INGEST_MAX_TEXTS_PER_DAY` | `vector-db.ts:534` | `20000` (rolling 24h, all embed providers) | **`250000`** | `20000` | Chunks/day ceiling. 250k chunks ≈ $0.31/day OpenRouter. Keep it a number, never remove the fuse. |
| `RAG_INGEST_BUDGET_ENABLED` | `vector-db.ts:530` | `on` | `on` | `on` | Never turn off — raise the number instead. |
| `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY` | `vector-db.ts:573` | `200000` (rolling 24h) | **`2500000`** | **`60000`** | Trial: must exceed `texts/day × ~8 WU` (250k × 8 = 2M) or it silently becomes the binding cap instead of the texts budget. After: 60k/day × 31 = 1.86M — keeps a 2M/month plan inside quota even with the pace guard off. |
| `RAG_PINECONE_WRITE_BUDGET_ENABLED` | `vector-db.ts:568` | `on` | `on` | `on` | |
| **`PINECONE_MONTHLY_WU_BUDGET`** (new) | `pinecone-monthly-pace.ts` | `0` (off) | **`0`** (trial has no monthly cap) | **`1600000`** (80% of a 2M plan) | Part B. Throttles the bulk backfill queue only; incremental ingest + retrieval never gated. |
| `SEC_FILING_RAG_MAX_PER_RUN` | catalog `source-settings-catalog.ts:175` → `sec-filings.ts:730` | **`25`** (see finding 3e) | **`200`** | `25` | Full 10-K/10-Q bodies per scheduled pass. |
| `SEC_FILING_INGEST_TTL_HOURS` | catalog → `sec-filings.ts:98` | `168` (weekly) | **`6`** | `168` | Makes the capped per-run ingest run ~4x/day instead of once a week. This is the cadence knob — there is no separate scheduler interval for this lane; it is TTL-gated inside `isFilingIngestDue`. |
| `SEC_INGEST_WORKER_ENABLED` | catalog (bool) | `off` | **`on`** | `on` | The durable, checkpointed backfill queue — the only path that can drive a large backfill without stalling the scheduler tick, and the lane the new pace guard throttles. Still requires an explicit seed: `POST /api/admin/sec-ingest {action:"seed"}`. |
| `PROVIDER_DISPATCH_OPENROUTER_PER_MIN` | `vector-db.ts:1454` | `600`/min | leave | leave | Already generous: at batch 32 that is 19,200 chunks/min of headroom. |
| `PROVIDER_DISPATCH_PINECONE_PER_MIN` | `vector-db.ts:1454` | `600`/min | leave | leave | Same. |
| `PROVIDER_DISPATCH_OPENROUTER_MAX_COST_USD_PER_DAY` | `vector-db.ts:1489` | `$25`/day when unset | leave | leave | 250k chunks/day ≈ $0.31 — nowhere near this fuse. Setting it to `0` is a deliberate STOP, not "unlimited". |
| `LLM_SPEND_CEILING` | `llm-budget.ts:313` | operator-set monthly USD | **verify headroom** | verify | `checkMonthlyLlmSpendCeiling()` gates the whole filing/transcript scheduler block (`scheduler.ts:566`). If it is breached, the filing ingest lane silently does not run — **check this first** if the trial backfill "isn't doing anything". |
| `RAG_RUN_BUDGET_CEILING` | `rag/run-budget.ts:33` | `5000` ops/rolling hour | leave | leave | **Not an ingest limiter** — it degrades RETRIEVAL (skips rerank/hybrid) only. Listed so nobody raises it "for the backfill" by mistake. |

Ordering note: raise `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY` **before** `RAG_INGEST_MAX_TEXTS_PER_DAY`,
otherwise the WU fuse becomes the binding cap and documents are skipped after their embeds were
already paid for (the embed stage now protects those vectors, but it is still wasted wall-clock).

Post-trial reversal ordering is the mirror: lower the texts/day budget first, then the WU/day
budget, then set `PINECONE_MONTHLY_WU_BUDGET`.

### 3e. Zero-code findings

1. **`SEC_FILING_RAG_MAX_PER_RUN`'s free/paid code defaults are unreachable.**
   `maxFilingsPerRunFromEnv()` (`sec-filings.ts:730`) calls `resolveSourceNumber(...)`, which
   returns the **catalog** `defaultValue: 25` when no user setting and no env var exist
   (`source-settings.ts:142-159`). Because 25 is finite and > 0, the function returns there and
   **never** reaches `isFreeTier() ? DEFAULT_MAX_FILINGS_PER_RUN (1) : DEFAULT_PAID_MAX_FILINGS_PER_RUN
   (200)` (`sec-filings.ts:118-119,732`). Both constants are dead unless the catalog entry is
   removed or its default set to 0. Not fixed here — the effective value is a knob decision, and
   changing the resolution order is a behavior change that deserves its own PR. Practical
   consequence: the "200 filings/run on a paid key" default the comments promise has never applied;
   set the value explicitly.
2. **The scheduled filing lane has no interval of its own.** It runs on every scheduler tick but is
   TTL-gated by `SEC_FILING_INGEST_TTL_HOURS` (default weekly) *and* by
   `checkMonthlyLlmSpendCeiling()`. Those two, not a cron cadence, are what set filing-ingest
   frequency.
3. **`corpus-reembed` is admin-triggered only** (`/api/admin/reembed`); no scheduler caller. It is
   deliberately **not** pace-gated: an explicitly requested operator backfill is an owner decision,
   and the daily WU/texts fuses plus the reactive breaker already bound it. Same reasoning for
   `refreshFilingBodies({ force: true })` behind `/api/admin/reindex-10k`.

---

## 4. Decisions & Trade-offs

- **Throttle the SEC ingest worker queue, nothing else.** That queue is the only *automated*
  producer of unbounded new backfill work. Gating `storeContexts`/`storeDocument` globally (the way
  the reactive breaker does) would also stop daily filing ingest and — via the same code path —
  anything else that writes, which the directive explicitly forbids.
- **The month counter accrues even when the budget is off.** It is one settings UPSERT per
  successful upsert batch, alongside a `rag_usage` INSERT that already happens. Without it, turning
  the budget on mid-month would project from a partial month and badly under-report. It is also the
  "what did the trial cost" number.
- **A throttled tick claims nothing rather than deferring claimed tasks.** Deferral is the reactive
  breaker's job (it knows a hard expiry instant). Pace is a soft, continuously re-evaluated
  condition with no known clear time, so "don't start new work" is the honest expression of it.
- **One advisory per calendar month, never re-armed on recovery.** Chosen over R2's
  crossed/recovered transition model because pace near a threshold oscillates and the owner asked
  for ONE advisory.
- **`runTick` made public.** Needed to drive one deterministic tick in tests; `processTask` was
  already public for the same reason.
- **Not done:** no UI rendering of the new number in `rag-coverage-client.tsx` (the directive scoped
  it to a one-line addition — the API field is that line); no change to the resolution order behind
  finding 3e; no secrets read or written.

---

## 5. Verification State

Run from the isolated worktree with `PATH="/opt/homebrew/opt/node@24/bin:$PATH"`:

```
npx tsc --noEmit
  -> clean (no output)

npx vitest run test/pinecone-monthly-pace.test.ts test/pinecone-wu-breaker.test.ts \
  test/rag-metering.test.ts test/rag-ingest-worker.test.ts test/sec-ingest-worker.test.ts \
  test/sec-ingest-seeder.test.ts test/usage-monitor-push.test.ts \
  test/background-worker-startup.test.ts test/llm-budget-enforcement.test.ts \
  test/vector-db.test.ts test/vector-db-document-receipts.test.ts test/embed-stage.test.ts
  -> Test Files 12 passed (12) | Tests 162 passed (162)

npm run lint
  -> 728 problems (0 errors, 728 warnings)   [grandfathered warn-level backlog]
```

Per the task scope, full `npm test` and `npm run build` were **not** run (landing operator does).

Webpack trap checked: `pinecone-monthly-pace.ts` imports only `./db` and `./db-health`; no `os`
import and no `node:`-prefixed specifier in any touched `src/` module.

## 6. Next Steps & Blockers

1. **Owner/orchestrator:** apply the section 3d TRIAL column in Infisical (agents must not write
   secrets). Start with `VECTOR_EMBED_BATCH_DELAY_MS=0` — it alone is worth ~50x on ingest rate.
2. **Then** `SEC_INGEST_WORKER_ENABLED=on` and seed the queue:
   `POST /api/admin/sec-ingest {"action":"seed","limit":<n>}`. Seed in slices sized to the corpus
   you intend to keep post-trial (see 3c.1), not the whole universe.
3. **Watch** `/api/admin/rag-coverage` → `providerUsage.pinecone.monthlyWriteUnitPace.mtd` to learn
   the real WU-per-chunk rate against this corpus, and cross-check it against the Pinecone console
   (the app's figure is its own byte estimate, not a billed number).
4. **Before downgrading:** set `PINECONE_MONTHLY_WU_BUDGET` to ~80% of the new plan's monthly WU
   allowance, and apply the AFTER column.
5. **Storage check before downgrade** — the binding post-trial constraint. Compare live index
   vector count (`providerUsage.pinecone.configuredIndexVectors`) against the target plan's storage
   limit; prune with the existing purge paths if over.
