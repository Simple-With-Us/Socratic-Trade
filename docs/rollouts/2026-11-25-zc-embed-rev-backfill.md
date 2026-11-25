# 2026-11-25 [ZC:   RR.3.S] — ST-4682 (OD-6): managed embedding revision bump to rev 4 plus bounded resumable backfill

## 1. Context & Objective

ST-4664 (PR #5464, merged Tue Nov 24) made every `storeDocument` filing/transcript chunk prepend a structured `[TICKER | FORM PERIOD | SECTION]` header to its `embeddingText`, but no embedding representation revision moved with it: `BASE_EMBED_REV` stayed 1 and `CLEAN_TEXT_EMBED_REV` stayed 2 unchanged.  Already-committed corpus rows therefore kept satisfying `storeDocument`'s committed-receipt reuse check on rerun and continued to serve headerless vectors - the exact stale-reuse Jay approved fixing as OD-6 (owner, Tue, Nov 24, 2026 11:26 PM CT).  This lane bumps the representation revision for exactly the population whose embedding input changed, and ships a bounded, resumable, dry-run-first backfill so the operator can drain the stale corpus off hours.  The LIVE re-embed run itself is a separately scheduled operator step, gated on ST-4675's daily embed cap raise; nothing here was run against production.

## 2. Changes Made

Design chosen: PER-CLASS revision, not a global bump.  The code supports the distinction cleanly because the header prepend in `storeDocumentImpl` is unconditional (independent of `VECTOR_EMBED_CLEAN_TEXT`) while every other writer goes through `storeContexts`, whose embeddingText did not change.

- **`src/lib/vector-db.ts`**
  - `vector-db.ts:535-539` - added `MANAGED_CONTEXT_EMBED_REV = 4`; per the lead's adjustment, 3 is deliberately skipped so this value never collides with an in-flight 3 from a sibling workstream (the constant comment says so).
  - `vector-db.ts:547-551` - `currentEmbedRev(managedContext = false)` now takes the class flag: the default keeps the historical 1/2 clean-text semantics for every existing caller; `managedContext = true` resolves to 4.
  - `vector-db.ts:557-559` - new named export `managedContextEmbedRev()` (the class-aware current revision; returns 4).
  - `vector-db.ts:420` and `vector-db.ts:446` - `embeddingSpaceRevisionForModel(model, managedContext = false)` / private `embeddingSpaceRevision(userId, managedContext = false)` thread the flag into the space tag.
  - `vector-db.ts:432-439` - new named export `currentManagedEmbedRevisionForModel(model)` - the exact string `storeDocument` now stamps (e.g.  `v4-baai-bge-m3`, or bare `v4` under voyage).
  - `vector-db.ts:5339` - `storeDocumentImpl` computes its `embedRev` as `embeddingSpaceRevision(userId, true)`.  This one line is the bump: the deterministic commit id, the occurrence vector ids, and the `embed_revision` receipt stamp for managed filings/transcripts all move to the rev-4 space, while `storeContexts` direct writes keep stamping `embed_rev` 1/2 via `cleanMetadata`.
- **`src/lib/rag/corpus-reembed.ts`** - run-level revision tracking switched to the managed space at three sites (`:191` progress surface, `:1069` run/watermark/live-coverage skip, `:1463` legacy-purge gate), because `purgeLegacyEmbeddingSpace` deletes every committed receipt whose `embed_revision` differs from its computed current revision - had it kept the non-managed tag, freshly re-embedded v4 vectors would have looked "legacy" and been purged.  This was the load-bearing interaction the design had to respect.
  - `:937-943` - `reembedExperienceMemory`'s dedup prefix intentionally stays on the NON-managed `storeContexts` space: experience lots never got the header, so they keep deduping against their prior writes instead of paying a spurious re-embed.
  - `:1338` - new export `runCorpusReembedAwaited(opts)`: the awaited, lease-serialized real run (same locked implementation `startCorpusReembedRun` detaches) for bounded CLI slices; the admin route is unchanged.
- **`src/lib/rag/embed-rev-backfill.ts` (new)** - DB-only planner + bounded driver:
  - `parseEmbedRevisionNumber` - `vN...` parses to N; missing/garbage parses to 0 (maximally stale, never throws).
  - `planEmbedRevBackfill()` - groups `vector_ingest_commits` (`state='committed'`) by `(vector_namespace, source)`; stale means a stamped revision below the target of 4; Reports per-collection commit/row counts, coverable vs live-touch-only stale rows, estimated embedding inputs (one per stale row) and estimated tokens (rows x configurable avg tokens/row, default 600, i.e. the 2400-char chunk cap at 4 chars/token).
  - Watermark - settings key `embedRevBackfill:progress`, cumulative lifetime totals per target revision.  A watermark stamped for a different revision is discarded (same rule the corpus-reembed watermarks follow).
  - `runEmbedRevBackfill()` - dry-run first (no writes, no runner call); execute mode drives slices through the injected runner, re-planning from the ledger after each slice so budgets count OBSERVED consumption.  Stop reasons: `exhausted`, `budget-rows`, `budget-tokens`, `embed-error-limit` (N cumulative failed candidates), `lease-busy`, `no-progress` (the runner moved neither the ledger nor its own counters), `embed-path-budget-fuse`.
- **`scripts/backfill-embed-rev.ts` (new)** - thin operator entrypoint over the above (matches the `backfill-asof-epoch.ts` "all logic in lib, script parses knobs" style, except it does NOT read `.env.local` - strict-Infisical policy).
  - Refuses to run at all without `--db <path>` (no default DB, so it can never open a stray `data/app.db`); refuses `--execute` unless `vectorWriteBackendOrNull()` reports `qdrant` - the retired Pinecone-only lane is never touched.
  - Env knobs: `BACKFILL_EMBED_REV_MAX_ROWS` (default 5000), `BACKFILL_EMBED_REV_MAX_TOKENS` (default 2,000,000), `BACKFILL_EMBED_REV_MAX_ERRORS` (default 5), `BACKFILL_EMBED_REV_BATCH_DOCS` (default 100), `BACKFILL_EMBED_REV_TOKENS_PER_ROW` (default 600), `BACKFILL_EMBED_REV_USER`, `BACKFILL_EMBED_REV_COVER` (CSV extra sources, e.g.  `insider-filing`).
  - Execute slices call `runCorpusReembedAwaited({ maxTexts })` so every candidate goes through the EXISTING embed path with its ledger receipts, daily budget fuses (`RAG_INGEST_MAX_TEXTS_PER_DAY` / write-unit breaker), lease serialization, and batch pacing intact - this script adds no second write path.
  - Invoke with `NODE_OPTIONS="--conditions react-server"` (the `server-only` exports map, same requirement as `scripts/eval/rag-production-eval.ts`).
- **Tests** - `test/embed-rev-backfill.test.ts` (new, 11 tests): revision values per class incl. clean-text flag interplay and the skipped rev 3; stale-below-target triggers re-embed, fresh-at-target reuses; parse rules; planner counts and budget math over a seeded ledger (multi-source, multi-namespace, aborted excluded); dry-run touches nothing; bounded execute, row-budget stop plus cumulative resume, foreign-revision watermark discard, embed-error cap, lease-busy, no-progress, fully-fresh ledger exits without calling the runner.  Temp SQLite only, mocked slice runner, no network.
  - Updated to the intended new stamps: `test/corpus-reembed.test.ts` (6 assertions: voyage managed tag `v1` to `v4`, bge managed tag `v1-baai-bge-m3` to `v4-baai-bge-m3`, including the two live-coverage skip seeds), `test/corpus-reembed-adversarial.test.ts` (voyage-era receipts `v1` to `v4`, current-space `v1-baai-bge-m3` to `v4-baai-bge-m3`; the pre-hardening gate-seed stamp moved too, so the test still probes the `watermarkEmbedRevision` gate rather than a revision mismatch), `test/vector-db-document-receipts.test.ts:142` (committed record stamp `v1` to `v4`).

## 3. Decisions & Trade-offs

- Per-class rev 4 over a global bump.  A global `currentEmbedRev()` bump would also invalidate `storeContexts` populations whose embeddingText never changed (user notes, chat memory, web sources, experience lots) - real embed spend for zero representation benefit.  The class boundary is exactly the `storeDocument` path, so `managedContext = true` is threaded only to `storeDocumentImpl`'s revision computation and to corpus-reembed's managed-run accounting.
- Rev 4, skipping 3 (lead directive during this lane): reserves the gap against an in-flight 3 elsewhere; the planner's stamped-below-target comparison still counts any stray 3 as stale.
- Backward compatibility for rev 1/2 rows is total by construction: reuse (`reusedCommitted` via the commit id, and the reconcile/receipt `embed_revision` equality checks at `vector-db.ts:7383` and `:8351`) always compares a stored vector against ITS OWN commit/receipt stamp, never against the live revision, so pre-bump vectors remain fully readable until they are re-embedded or purged - stale-to-reuse, never a read failure.  The retrieval admission path (`filterMatchesForCommittedReceipts`) and `/api/health` are unaffected.
- Non-managed numeric stamps unchanged: `cleanMetadata` still writes `embed_rev` 1/2 for direct writes; managed vectors additionally carry the authoritative STRING `embed_revision` (`v4-...`) from the commit ledger, which is what every reuse/reconcile comparison actually consumes.  Bumping only the string keeps the blast radius at exactly the changed-text class.
- corpus-reembed's run-level revision label also drives the experience-memory watermark chain - kept on the managed tag for accounting simplicity (one run-level value, one discard rule), with the dedup prefix split to the non-managed space so experience lots are not re-embedded; documented at the site.
- Backfill executes through the existing embed path, not a new one, so budget fuses, receipts, leases, and pacing apply automatically.  The script's own budgets (rows/tokens/errors) are additive safety rails, and the daily embed fuse remains the true spend authority.
- Estimates are estimates.  Token figures use a configurable flat average per chunk row because the commit ledger does not store text lengths; the dry-run prints the knob so the operator can tighten it before `--execute`.

### Blast radius (honest statement - which documents re-embed on next touch)

- Re-embeds on next touch or backfill (stamped rev < 4): every committed `storeDocument` population - SEC filings (10-K/10-Q and the `sec-edgar`-sourced 13-F rows), `sec-8k` summaries, `earningscalls-dev` plus `earningscalls-roic` and `fmp-earnings-transcript` transcripts, `insider-filing` Form-4 cards, SEC ingest-worker documents, and processed-corpus writes - i.e. exactly the class whose embeddingText gained the structured header.
- NOT touched (stay rev 1/2, no re-embed, no cost): `storeContexts` writers whose input text did not change - user notes, chat/journal memory, experience-memory lots (dedup prefix deliberately pinned to the non-managed space), and every other direct write.
- Retrieval between bump and backfill: unchanged.  Old vectors score and cite as before; new writes land in the v4 space and are admitted by their own receipts.  The two spaces coexist exactly as the model-flip spaces already do - embedding-space isolation is the existing mechanism.
- Vector-id/commit-id churn: re-ingested documents mint NEW deterministic ids (they embed the revision), so old v1/v2 occurrences linger until `purgeLegacyEmbeddingSpace` retires them.  That purge stays gated behind a completed, failure-free full scan under v4 plus the operator's `purge-voyage-vectors` confirm token - nothing deletes automatically here.

## 4. Verification State

Commands run in the lane (Node 22; the known Node-22 cpuprofile failure class is unrelated and untouched):

```
npm run lint            # 0 errors (916 pre-existing grandfathered warnings)
npx vitest run test/embed-rev-backfill.test.ts
npx vitest run test/corpus-reembed.test.ts test/corpus-reembed-adversarial.test.ts test/embed-rev-backfill.test.ts
npx vitest run test/vector-db-document-receipts.test.ts test/embedding-space-isolation.test.ts test/vector-db-staleness-and-clean-text.test.ts
npx vitest run test/rag-ingest-worker.test.ts test/fmp-transcripts.test.ts test/web-sources-sec.test.ts
npx vitest run test/vector-db-chunk-cap.test.ts test/vector-db-scope.test.ts test/vector-ledger-authority-legacy.test.ts test/pinecone-write-class.test.ts test/memory-lifecycle-wiring.test.ts test/persistence-hardening.test.ts
npx vitest run test/corpus-wide-lexical.test.ts test/rag-near-dup-store.test.ts test/rag-near-dup-review-fixes.test.ts test/account-deletion.test.ts
```

Results: every suite above passed after the stamp updates (31 passed for the core trio; 11 of them new).  Script smoke (throwaway migrated SQLite in a scratch dir, no network): no `--db` - refused with exit 2; `--db <tmp> --execute` with no Qdrant endpoint - refused; dry-run against a seeded ledger printed correct per-collection stale counts, target `v4-baai-bge-m3`, and the embed/token estimate.

The script was NOT run against production and nothing in this change contacts a live service.  `npx tsc --noEmit`, `npm run build`, and the full suite are left to the lead's serialized full gate per the lane instruction.

### Operator runbook (LIVE re-embed - off-hours, after ST-4675's daily embed cap raise)

1. Dry-run first, inside the app's secret context: `NODE_OPTIONS="--conditions react-server" npx tsx scripts/backfill-embed-rev.ts --db <app.db path>` - review per-collection stale counts and the token estimate; adjust `BACKFILL_EMBED_REV_*` knobs.
2. Bounded execute overnight: same command plus `--execute` - it stops at its row/token/error budgets or the embed path's own daily fuse, is resumable across restarts (settings watermark plus corpus-reembed's own per-docType watermarks), and exits non-zero unless the ledger's coverable stale rows reach 0.
3. Verify a sample: re-run the dry-run (coverable stale should shrink), and inspect one re-embedded filing's vector metadata (`embed_revision = v4-...`) plus its stored embedding input, which must lead with the `[TICKER | FORM PERIOD | SECTION]` header.
4. Only after a completed failure-free full scan under the current space may the existing `purgeLegacyEmbeddingSpace` admin gate (`confirm: purge-voyage-vectors`) retire the pre-header vectors - leave that a separate deliberate decision.

## 5. Next Steps & Blockers

- ST-4675 (the daily embed cap raise) must land before any `--execute` run against production; the live re-embed is off-hours operator-scheduled and coordinated separately per OD-6's scope.
- Lead runs the full serialized gate (tsc, full vitest, build) on this lane.
- PR: `Fixes ST-4682` (parent ST-4668).
