# 2026-08-31 - Qdrant read-path cutover, stage 1 (owner-directed "do it now")

## Context & Objective

Pinecone read units are exhausted month-to-date and the trial has lapsed — strategy
decisions were running with NO RAG context, silently (audit
`docs/rollouts/2026-08-31-qdrant-rag-error-ux-audit.md`, boards `9e19673a` +
`d2ac60c9`).  Owner directed immediate execution.  Stage 1 = READ path only: dense
retrieval queries can be served by the self-hosted Qdrant, runtime-switchable, defaulting
to pinecone in code with prod flipped via env.  Writes/deletes/inventory remain on
Pinecone (stage 2).  Built by an agent team (adapter + golden set + scripts) with an
adversarial review pass; review verdict SHIP-WITH-FIXES-APPLIED.

## Changes Made

- `src/lib/vector-store/pinecone-filter-to-qdrant.ts` (NEW) — Pinecone-filter -> Qdrant
  translator: $eq/shorthand, $in, $ne, range ops, $exists:true (must_not is_empty),
  $exists:false (should[is_empty, sentinel]), $and/$or nesting incl. the exact composite
  shapes vector-db builds.  Throws `UnsupportedPineconeFilterError` on anything
  unimplemented — a dropped clause could leak cross-tenant/post-asOf data, so it refuses
  loudly instead.
- `src/lib/vector-store/qdrant-read.ts` (NEW) — backend resolution (DB knob
  `RAG_VECTOR_READ_QDRANT` > env `RAG_VECTOR_READ_QDRANT` > env
  `RAG_VECTOR_READ_BACKEND` > pinecone; qdrant requires `QDRANT_URL`),
  namespace->tenant mapping (identity; default ns = `""`, live-verified),
  `qdrantQueryTier()` (points/search with hnsw_ef 128, rescore + oversampling 2.0,
  maps hits to `{id: payload.pc_id, score, metadata minus pc_id/ns}`), qdrant metering
  (provider "qdrant", no phantom Pinecone WUs).  Review fix: sentinel values
  (`__absent__`, as_of 0) are STRIPPED from returned metadata — otherwise
  `filterMatchesForTenantVisibility` would silently drop every backfilled legacy vector.
- `src/lib/vector-db.ts` — query path only: exported `vectorNamespaceName()` factored
  from `vectorDataIndex` (names cannot drift between backends); `denseTierQuery`
  dispatcher replacing the six inline Pinecone tier queries (pinecone branch
  call-for-call equivalent); metering branch; stage-trace provider reports the real
  backend.  Review fixes: (a) qdrant reads are gated to embed spaces the mirror actually
  holds (voyage-* passes stay on Pinecone — the copy deliberately skipped voyage-era
  points, and cross-space cosines clear the 0.30 floor with garbage); (b) ALL qdrant
  tiers failing rethrows -> the existing `lookup_failed` path, so a Qdrant outage is a
  visible skip-RAG, not a successful empty retrieval.  Partial tier failure
  soft-degrades (deliberate cutover resilience).
- `src/lib/server-knobs.ts` — new `retrieval` group + boolean knob
  `RAG_VECTOR_READ_QDRANT` (default false), so the backend is flippable at runtime from
  Admin > Operations with no redeploy.
- `test/pinecone-filter-to-qdrant.test.ts` (22 tests incl. deep-equal pins of the three
  production composites) + `test/qdrant-read.test.ts` (15 tests, mocked fetch).
- `scripts/eval/golden/rag-production-golden-v1.json` (NEW) — 71 frozen golden cases
  (30 symbols, 44 accessions, 9 categories incl. PIT/as-of negatives), exact-chunk +
  section-level partial-credit refs.  All 72 evidence refs verified present in live
  Qdrant (72/72 filtered-count check).  Provenance note embedded: derived from the
  Qdrant copy while Pinecone reads were exhausted -> the gate measures ABSOLUTE
  recall/ranking; re-record a Pinecone parity baseline after Sep 1 if still wanted.
- `scripts/qdrant/sentinel-backfill.py` (NEW) — batched, checkpointed, dry-runnable
  sentinel stamping for `$exists:false` fields.  Live dry-run: 0 missing today (the
  08-28 copy stamped full payloads); needed after each delta copy.
- `scripts/qdrant/DELTA-RUNBOOK.md` (NEW) + `scripts/qdrant/pinecone-to-qdrant-copy.py`
  (delta fix: `done_ns` now records per-namespace vectorCount and revalidates via one
  stats call, so a re-run is a cheap true delta instead of skip-everything-forever or
  full rescan).

## Decisions & Trade-offs

- **Prod flips to qdrant reads at deploy** via Infisical env `RAG_VECTOR_READ_QDRANT=true`
  (set before merge; boot env fetch picks it up).  Rationale: current state is
  guaranteed-zero RAG (read units exhausted), worst-case adapter failure is the SAME
  skip-RAG outcome via `lookup_failed`, and revert is instant (Admin knob DB override
  beats env, or unset env + restart).  This is the correctness-preserving version of
  "ship now".
- The local golden-eval LIVE run is blocked on a query-embedding key:
  `SILICONFLOW_API_KEY` in the handoff file returns 401 (observed; per the
  never-mint/never-hunt rules this is an owner decision — refresh the key or hand off a
  valid one) and per-user OpenRouter keys don't exist locally by design.  Production
  embeds queries with its own working keys, so post-flip production telemetry is the
  live validation; the frozen set becomes the local regression gate once a key is handed
  off.
- `indexExists`/`assertIndexMetric` still touch Pinecone control-plane even when reads
  are qdrant (stage-1 minimal edit); Sentry outer-catch provider label still says
  "pinecone" (cosmetic; follow-up).  Stage 2 owns writes/deletes/inventory + full
  Pinecone retirement.

## Verification State

- `npx tsc --noEmit` clean; new suites 37 tests green; 16 nearest retrieval/knob/metering
  suites 225 tests green; eslint 0 errors on touched files (pre-existing warnings only).
- Live (read-only): default-ns facet proved `ns=""` (5,490 pts); the module's exact
  points/search body accepted by the deployed v1.19.0 with pc_id originals returned;
  sentinel dry-run 0-missing; 72/72 golden refs present.
- Full gate + land via `scripts/land.sh` (tsc -> vitest -> build) on this PR.

## Next Steps & Blockers

1. After merge/deploy: `bash scripts/verify-deploy-sha.sh`; confirm qdrant serving via
   retrieval stage-trace provider + container logs; watch the first strategy passes.
2. Sep 1 (read units reset): run `scripts/qdrant/DELTA-RUNBOOK.md` — delta copy ->
   sentinel backfill -> golden eval; then stage 2 (write path port + Pinecone retirement
   decision).
3. Owner: refresh/hand off a valid `SILICONFLOW_API_KEY` (observed 401) if the local
   golden gate should run before Sep 1.
4. Qdrant snapshot->R2 cron + mesh watchdog (still open from the audit).

## Replaced Docs

None.
