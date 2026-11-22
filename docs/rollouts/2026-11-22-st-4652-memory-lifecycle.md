# ST-4652 episodic vector lifecycle + opt-in recency weighting (2026-11-22, Muse Code MC)

## Context & Objective
ST-4650 fleet-sweep Batch B: `memory-decay.ts` scoring and the `vector_doc_lifecycle` table existed, but `recordVectorDocSeen`/`archiveVectorDocs` had zero production callers while retrieval bumped lifecycle rows no writer inserted, and experience retrieval had no recency term at all.

## Changes Made
- `src/lib/vector-db.ts`: after a successful non-managed `storeContexts` upsert, record first-seen lifecycle rows for actually-indexed episodic documents (`socratic-decision`, `coach-note`, `lesson`, `experience`) keyed by the stable upserted vector id.  `recordVectorDocSeen` upserts on `(user_id, vector_id)`, preserving `first_seen_at` and retrieval counts on repeat writes.  The hook is fail-soft (missing table/export or SQLite contention cannot fail memory storage) and filing/disclosure doc types are excluded.
- `src/lib/memory-decay.ts`: `applyMemoryDecayWeighting`/`memoryDecayMultiplier` — positional RRF (K=60) with a +/-15% recency band, undated chunks neutral, fail-open.  Opt-in via `RAG_MEMORY_DECAY_WEIGHTING` (existing `envFlagOn` convention), default OFF.
- `src/lib/experience-memory.ts`: the decay pass composes last, after usefulness and affinity, only when the flag is enabled; age comes from each chunk's own stamped date, never a lifecycle-table lookup.
- Tests: `test/memory-lifecycle-wiring.test.ts` (new), `test/memory-decay.test.ts`, `test/experience-memory.test.ts`.

## Decisions & Trade-offs
- No migration: the lifecycle table already exists (migration 80).  Pre-existing dedup-skipped vectors gain a row only on their next real re-upsert; a backfill sweep and any soft-archive scheduler stay follow-ups, and `shouldSoftArchive`/`archiveVectorDocs` remain unwired by design.
- Recency is an owner-controlled opt-in, not a new default: unset/off preserves the exact prior ordering, and the band caps displacement so recency alone cannot override similarity/usefulness/affinity.
- Learned-context retention intentionally unchanged: supersede-on-write plus the daily learning-review `expireLearnedContext` verdict is the owner-reviewed path.  Age-based auto-expiry would need a per-kind TTL policy, a coach-promoted exemption, and dry-run receipts first.  Latent gap left for that design: `findLiveLearnedContextBySubject` does not filter `expires_at`, so re-asserting an identical expired fact no-ops against the expired row.

## Verification State
- Writer lane: lifecycle wiring 6/6, memory-decay 14/14 + experience-memory 19/19, regression sets 61 + 64 + 18 passed; `npx tsc --noEmit` clean; eslint on touched files 0 errors.
- Parent on harvested tree (after merging current `main`): full `npm run lint` 0 errors, `npx tsc --noEmit` clean, targeted vitest 13 files / 182 tests passed, `npm run build` exit 0.  Full serial suite runs in CI verify.

## Next Steps & Blockers
- Land one of ST-4652/ST-4653 first and rebase-rerun the second: both edit `src/lib/experience-memory.ts` (different regions: retrieval ordering vs closed-lot recording).
- Backfill/soft-archive scheduling and the learned-context retention design remain separate owner-reviewed follow-ups.

## Zero-Code Findings
- `RAG_MEMORY_DECAY_WEIGHTING` is an environment opt-in with no production enablement in this PR; ranking behavior in production is unchanged until the owner sets it.
