# Backlog clearing plan + Codex-audit execution map (2026-07-18)

Owner-directed program (CLAUDE coordinator): reindex all filings on `baai/bge-m3`, clear the
RAG/filings backlog, and address the 46-item Codex audit. This document is the quantified plan
and the cross-lane disposition map. Board rows: see `docs/EFFORT-LOG.md` (In Progress).

## 1. Backlog, quantified (verified 2026-07-17/18)

| Backlog | Current | Target | Gap |
|---|---:|---:|---|
| Pinecone corpus (`socratic-trade`, 1024-dim) | 8,476 vectors (8,089 shared + 387 user-scoped) | 600k–1.2M (plan baseline) / 1.1M–2.5M (with depth) | ~99.3% un-ingested |
| SEC filings ingested (10-K/10-Q) | prod had "two filings ever ingested" as of 2026-07-09 (code comment, `sec-filings.ts:107-110`); demand-first weekly cadence since | 1,000 issuers × (1×10-K + 4×10-Q) ≈ 5,000 filings baseline | effectively the whole program |
| EarningsCalls transcripts | 0 (dormant — RapidAPI subscription not completed; probes 405) | ~90 transcripts/month max (6 req/day, 180/200 monthly budget) | owner action to activate |
| FMP transcripts | 0 (double-gated off: `WEB_SOURCE_FMP_TRANSCRIPTS` + rights flag; endpoint not entitled) | ~8–12/day when entitled | owner entitlement decision |
| Congress/8-K/fundamentals RAG | flowing on their own cadences | — | not a backlog; refresh independently |

**Why the scheduled path can never clear it:** `refreshFilingBodies` runs on a weekly TTL
(`SEC_FILING_INGEST_TTL_HOURS=168`) with a per-run cap (200 paid / 1 free tier, inferred from
`VECTOR_EMBED_BATCH_DELAY_MS`), demand-first symbols only (watchlist/policy universes — the
1,000-CIK manifest has no runtime consumer). Best case ≈ 200 filings/week ⇒ ~25 weeks for the
baseline, and the 2026-07-12 plan review explicitly forbids using this path as the backfill
architecture. The durable substrate (migration v23: `sec_ingest_jobs`/`sec_ingest_tasks`/
`sec_ingest_task_attempts`/`sec_request_coordination` + `db-rag-ingest.ts` CRUD + the
`SecIngestWorker` state machine from #1669) existed with **zero production callers** — that is
the unlock, now being wired (§3).

**Throughput bounds that actually govern the backfill:**
- Daily fuses: `RAG_INGEST_MAX_TEXTS_PER_DAY` = 20,000 embeds/day, `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY`
  = 200,000 WU/day (both consulted by the worker path too). At defaults: 600k–1.2M vectors ⇒
  **30–60 days**. Raising the ingest fuse ~5× (cost is no longer the constraint, see below)
  brings this to the plan's 6–12-day envelope; SEC politeness (4 req/s token bucket, P2) and
  the box's CPU become the practical limits.
- Embedding cost on bge-m3 is a non-factor: **~$7.50 total** for the full 1.2M-chunk program
  at OpenRouter's $0.01/M tokens (vs $65–$210 Voyage) — even the broad upper-bound program
  (~3B tokens) is ~$30.

## 2. Embedding migration to `baai/bge-m3` — state + sequencing

Most of the swap **already shipped in #1669** (merged, not yet deployed): key-presence routing
(`activeEmbeddingModel()`: `OPENROUTER_API_KEY` ⇒ `baai/bge-m3` via
`https://openrouter.ai/api/v1/embeddings`), embedding-space isolation (vector-id revision suffix
`v1-baai-bge-m3` + `embed_model` Pinecone query filter), same 1024-dim/cosine index (no new
index needed), model-keyed embed caches. Host decision: **OpenRouter primary** ($0.01/M, existing
key, aligns with the all-OpenRouter directive; DeepInfra/Parasail backends), Cloudflare Workers
AI `@cf/baai/bge-m3` as env-switchable fallback ($0.012/M, documented 3,000 req/min).

**The flip is armed:** prod already carries `OPENROUTER_API_KEY` (chat cutover), so the next
successful deploy of main switches all RAG embedding+rerank to the OpenRouter path. Two defects
ride that flip, hence the sequencing:

1. **Metering bug (live on main):** `meterEmbed`/`meterRerank`/`estimateVoyageDispatchCost`
   hardcode `provider:"voyage"`; bge-m3 usage would be mislabeled and priced off the Voyage
   table (~10× overstatement) into budgets/dashboards. Fix lane: `claude/bge-m3-metering-gate`
   (also adds explicit `RAG_EMBED_PROVIDER` so key presence alone never flips RAG silently).
   **Must land with/before the flip deploy.**
2. **Retrieval sparsity:** the query filter switches to the bge space, hiding all 8,476 Voyage
   vectors. Fix lane: `claude/corpus-reembed` — idempotent, budget-fused, `RAG_REINDEX`-lease-
   serialized re-embed of everything persisted locally (filings text from `document_chunks_fts`,
   EarningsCalls from `earningscalls_transcripts.content`, closed-lot experience replayed from
   `fill_events`, insider docs from `sec_insider_transactions`) + explicit legacy-Voyage purge
   action (never automatic). **Runs immediately after the flip deploy** (admin-triggered,
   server-side, uses the app's own keys — minutes-to-hours at current corpus size).

Out of scope for re-embed (refresh on their own cadence): 8-K summaries, FMP transcripts
(rights-gated), congress trades, fundamentals cards.

## 3. Backfill execution plan (1,000 issuers)

Lane `claude/sec-ingest-worker-wiring` closes Codex items 2/3/4:
manifest generator emits the validator-conformant versioned `FrozenSecUniverseManifest`
(committed artifact regenerated deterministically from the existing 1,000 issuers, validated in
CI by a test against the real file); a manifest→jobs seeder (idempotent natural keys; dead-letter
discipline — permanently-unfetchable documents terminalize and are never re-seeded, completion =
all-terminal not zero-pending, per the Congress.Trade $1,153 runaway-loop lesson); and
`SecIngestWorker` startup gated on `SEC_INGEST_WORKER_ENABLED` + an admin seed/status route.

**Run sequence once lanes land + deploy pipeline is fixed:**
1. Deploy (flip + metering fix together). Verify health + `rag_usage` provider stamps.
2. Admin re-embed run → retrieval recovery over the existing corpus (same day).
3. Seed pilot: first ~25 manifest issuers → watch worker receipts/dead-letters ≥1 day
   (parser quality, 429 rate <1%, WU within fuses — the plan's pilot gates).
4. Raise `RAG_INGEST_MAX_TEXTS_PER_DAY` (suggest 100k) via Infisical; seed the remaining 975
   issuers in rank order. Projection: **6–12 days** at 100k verified chunks/day; ~$5–$10 total
   embed spend; Pinecone WU ≈ $15–$55; storage 4–12 GB (~$1.30–$4/month at Standard rates).
5. After coverage report shows baseline complete: run the explicit Voyage-purge action; then
   evaluate selective 3-year depth (plan Phase 4) as a separate owner decision.

## 4. Owner-action activation checklist (blocking items only)

1. **Deploy drift (blocks everything):** prod serves `70a2a39d` (2026-07-17 19:03 CT); main is
   7+ commits ahead; a 06:48Z restart kept the old SHA. The GitHub-App webhook is evidently not
   producing builds. Coolify token in the handoff file 401s and the MCP won't connect — need a
   fresh `COOLIFY_API_TOKEN` or a dashboard look at socratic-trade-prod's deployment list (and
   whether GitHub webhook IPs are being 403'd by the CF zone allowlist again, the pre-2026-07-10
   failure mode).
2. EarningsCalls: complete the free-plan subscription on RapidAPI to activate transcripts
   (lands dormant otherwise).
3. Optional: FMP transcript entitlement + rights flags if that corpus is wanted.
4. `SEC_INGEST_WORKER_ENABLED=1` + fuse raise in Infisical when ready to run the backfill
   (step-by-step in §3).

## 5. Codex-audit disposition map (all 46)

| # | Item | Disposition |
|---|---|---|
| 1 | Prod 5+ commits behind; exact-SHA verify | **OWNER/ops blocker** (§4.1); CODEX confirmed and declined manual deploy per protocol |
| 2 | Manifest invalid (bare array) | **CLAUDE in build** (`sec-ingest-worker-wiring`) + CI validation of committed artifact |
| 3 | Manifest not connected to ingestion | **CLAUDE in build** (seeder) |
| 4 | SecIngestWorker dormant | **CLAUDE in build** (startup wiring + admin route) |
| 5 | Stop placement lacks durable intent | **CLAUDE in build** (`stop-intent-idempotency`) |
| 6 | Recovered stop fills not atomic/idempotent | **CLAUDE in build** (same lane) |
| 7 | Fixed/ATR stops unprotected between runs | **CLAUDE in build** (`stop-coverage-alpaca-tif`) |
| 8 | Halted accounts can place broker stops | **PR #1738** (existing lane; CI-runner unblock landing) |
| 9 | Tradier market-to-limit strips brackets | **PR #1738** |
| 10 | Alpaca fractional GTC rejection | **CLAUDE in build** (`stop-coverage-alpaca-tif`) |
| 11 | SSRF via baseUrl/webhook URLs | **CLAUDE in build** (`egress-ssrf-body-caps`) |
| 12 | CF Access header trust w/o JWT validation | **CLAUDE in build** (`cf-jwt-enckey-fingerprints`) |
| 13 | Unbounded webhook bodies; per-request JWKS | **CLAUDE in build** (`egress-ssrf-body-caps`) |
| 14 | Silent process-local encryption key | **CLAUDE in build** (`cf-jwt-enckey-fingerprints`) |
| 15 | Usage screens reveal key material | **CLAUDE in build** (same lane) |
| 16 | Claude reasoning wrong shape via OpenRouter | **PR #1733** (existing lane) |
| 17 | OpenRouter native-credential assumptions | **PRs #1733/#1737** |
| 18 | Evidence contradicts rationale (T yield) | **Deferred follow-up** — immutable decision-time evidence snapshot; design item, queued next wave |
| 19 | Anomalous data approved (AMX FCF) | **Deferred follow-up** — anomaly quarantine; queued with 18 |
| 20 | Wrong portfolio context to Red | **Deferred follow-up** — decision-time portfolio receipt; queued with 18 |
| 21 | Red Team timeout auto-recovery | **Deferred follow-up** — bounded retry/failover + UI retry; queued next wave |
| 22 | "Held" + "Order filled" contradiction | **CLAUDE in build** (`decision-status-truth`) |
| 23 | Day P&L vs 10-day-old snapshot | **CLAUDE in build** (same lane) |
| 24 | Stale paid data freshness split | **CLAUDE in build** (display slice; decision-gating deferred) |
| 25 | SEC discovery failure suppresses retries a week | **CLAUDE in build** (`sec-ingest-worker-wiring` reviews `lastAttempt`; worker path supersedes weekly TTL for backfill) |
| 26 | 75/50 candidate count | **CLAUDE in build** (`decision-status-truth`) |
| 27 | Per-field freshness on scan | **Deferred follow-up** (field-level source/timestamp; larger UI change) |
| 28 | Alert lifecycle noise/grouping | **Partial** (earningscalls noise fixed in #1728 + MONET wave); incident grouping deferred |
| 29 | "Running now" while market closed | **CLAUDE in build** (`decision-status-truth`) |
| 30–32 | iOS typed-confirm / SSE double-load / logout-on-5xx | **CLAUDE in build** (`ios-client-fixes`; needs owner Xcode build to verify) |
| 33 | server-metrics 502 behind Cloudflare | **CLAUDE in build** (`ops-display-truth-batch`) |
| 34 | usage-monitor degraded surfacing | **Partial**: bridge outage is a cross-app ops item (Sentry W, 3 days); cost-screen banner deferred |
| 35 | All open PRs blocked | **CODEX landing** CI-runner rerouting to self-hosted `socratic-ci`; auto-merge armed on all six |
| 36 | Sentry CI reporter failing | **Expected to clear with #35** (same runner-provisioning root cause); re-check after |
| 37 | Tests make live SEC requests | **Deferred follow-up** (deterministic CIK resolver injection) |
| 38 | Wrong live-board filename in audit | **CLAUDE in build** (`ops-display-truth-batch`) |
| 39 | 4–5s intro blocks cold loads | **Deferred follow-up** (skeleton + skip-for-returning; design-sensitive — owner likes the intro) |
| 40 | Decision cards prose walls | **Deferred follow-up** (evidence-aware collapse) |
| 41 | Settings waterfalls/size | **Deferred follow-up** (parallelize + split; WS-E UI backlog) |
| 42 | Usage page IA | **Deferred follow-up** |
| 43 | Orders "20finished" + lifecycle grouping | **Typo/executed-qty in build** (`ops-display-truth-batch`); grouping/filters deferred |
| 44 | Capabilities unconfirmed + dead keyboard stop | **Deferred follow-up** (small; next batch) |
| 45 | OpenRouter models branded as OpenAI | **CLAUDE in build** (`ops-display-truth-batch`, dedup vs #1733/#1737 checked in-lane) |
| 46 | Copy/data-quality pack | **Split**: part shipped in MONET wave; remainder in build (`ops-display-truth-batch`) |

Deferred follow-ups above are the next wave once the ten in-build lanes land; the
decision-quality cluster (18–21) is the largest and most design-sensitive of them.

## 6. Verification and landing discipline

Each lane: focused tests + tsc in its worktree; coordinator runs adversarial verification
(frontier lens on money-path/security diffs), then lands serially via `scripts/land.sh` (full
gate incl. build) once the CI-runner rerouting from CODEX makes `verify` dispatchable. Merge ==
auto-deploy *once the Coolify drift is fixed*; each deploy re-verified against `/api/health`
exact SHA per the deploy-verify skill.
