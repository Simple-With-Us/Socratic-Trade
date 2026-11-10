# 2026-08-18 — rag-embed soft-degrade (no 503 / no autonomy halt)

## Context & Objective

A hard-stopped `rag-embed` lane 503'd `/api/health`.  Coolify treats that as container death, restarts Docker, and the boot interlock re-halts Green/Red.  One dead embed must degrade that lane only — like OpenRouter credits — without taking down the app, the embed queue, or autonomy.  `pinecone` and `alpaca-broker` stay critical.  Did not steal #2792/#2798/#2800/#2794.

Rebased onto `origin/main` `6429d984` (live SHA that 503s today).  Real conflict was only `docs/phase-7-strategy.md`; kept this stanza plus main's #2829 OpenRouter/`require_parameters` note and #2800 fuse paragraph.  `src/lib/vector-db.ts` auto-merged: `embedDocumentsLaneOrSkip` and `selectItemsWithinWriteBudget` both remain.

## Changes Made

- `/api/health` no longer adds `rag-embed` / `rag-rerank` to `criticalServices`.  A hard-stopped embed/rerank lane is reported `ok: false` + `degraded: true` and the probe stays HTTP 200.  Pinecone and Alpaca still 503 the probe.
- `storeContexts` isolates a thrown document-embed call to that batch.  Later batches still embed and upsert.  Managed commits still require every chunk (`documentComplete` stays false if any batch died).
- Query embed now returns null on a thrown provider call (same contract as a malformed vector).  Retrieval fail-opens; Green/Red already skip RAG on `lookup_failed`.

Touched files:

- `app/api/health/route.ts`
- `src/lib/vector-db.ts`
- `test/connection-health-routing.test.ts`
- `test/vector-db-embedding-integrity.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-08-18-rag-embed-soft-degrade.md`

## Decisions & Trade-offs

- Demoted both `rag-embed` and `rag-rerank`.  The user named rag-embed; rerank already fail-opens and the same 503 would restart Docker.  Critical set is now only `pinecone` + `alpaca-broker`.
- Did not touch FilingAPI (#2792/#2798), Pinecone 15-WU remainder (#2800), or iOS (#2794).
- Integrity still rejects the poisoned batch (no upsert of malformed vectors).  The old `break` that parked later batches is now `continue`.
- Lease loss still throws.  That is a concurrency boundary, not a provider outage.

## Verification State

Rebase onto `origin/main` `6429d984` (2026-08-18 hotfix pass):

```bash
git merge-tree --write-tree origin/main HEAD   # exit 0 after rebase
git merge-base --is-ancestor origin/main HEAD  # true
npm run lint          # exit 0 (warnings only)
npx tsc --noEmit      # exit 0
npm test -- test/connection-health-routing.test.ts -t "degrades a hard-stopped rag-embed|still 503s on a hard-stopped pinecone|does not fail liveness on a hard-stopped legacy|survives a pinned-but-keyless"
# 5 passed / 21 skipped
npm test -- test/vector-db-embedding-integrity.test.ts test/rag-multi-query-retrieval.test.ts
# 27 passed
npm run build         # exit 0 (Next.js 16.3.1 webpack)
```

`git merge-tree` before rebase exited 1 on `docs/phase-7-strategy.md` only.  `src/lib/vector-db.ts` auto-merged.  Linux VM: no xcodebuild.  A full `npm test` on this VM still fails leftover SiliconFlow `embed_revision=v1-baai-bge-m3`, notify/Pushover, and SEC/Yahoo 404s.  Those files were not touched.  The rag-embed liveness + isolate cases above are the gate for this change.

## Next Steps & Blockers

- Land this PR.  After merge, confirm live `/api/health` stays 200 with a dead embed lane and that Coolify does not restart.
- No owner action required.  Do not raise the Pinecone WU fuse.  Do not steal the reserved PRs.  Do not revert #2800 or #2829.

## Zero-Code Findings

The Docker/autonomy kill path was health-only: five consecutive hard `rag-embed` rows → `ok=false` → HTTP 503 → Coolify restart → `autonomy_halted_on_boot` unless `autoResumeOnBoot`.  Scheduler/strategy auto-halt only on broker health, not RAG.  SEC ingest already isolates per task.  Query retrieval already had an outer fail-open catch; the remaining gap was a thrown embed aborting later store batches and 503ing the probe.
