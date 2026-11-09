# 2026-08-17 — RAG / learning / recall audit (report-only)

## Context & Objective

Owner asked for a read-only audit of data ingest, SEC/ROIC/transcripts/news, chunking/embedding, dedupe, metadata, indexing, retrieval quality, recall/precision, grounding, staleness, lineage, the learning ledger, feedback loops, model memory, evals, and failure recovery.  Goal: one evidence-backed report with quantitative eval recommendations, severity, upgrades, and a gold-set test plan — no product-code change.

## Changes Made

Docs only.  No `src/**`, `app/**`, `ios/**`, or test behavior change.

- `docs/audits/2026-08-17-rag-learning-recall.md` — full audit (architecture, 40+ findings with file:line evidence, metrics, gold-set plan, P0–P3 upgrades).
- `docs/rollouts/2026-08-17-rag-learning-recall-audit.md` — this note.
- `STATUS.md` — current handoff.
- `PLAN.md` — scope pointer.
- `docs/EFFORT-LOG.md` — Planned → In Progress row.
- `docs/phase-7-strategy.md` — pointer to the audit for learning/RAG residual gaps.

## Decisions & Trade-offs

- Report-only PR.  Highest-severity code fixes (worker raw-HTML embed, production-eval merge gate, chat/desk `asOf`) are listed as next-agent work, not implemented here.
- Did not flip knobs, raise the Pinecone daily WU fuse, or re-enable FilingAPI/FMP.
- Production Infisical `VECTOR_ASOF_STRICT=on` (2026-08-16) is noted; code default remains OFF, and callers that omit `asOf` still bypass strict mode.
- Two-space sentence rule applied in new prose.

## Verification State

Read-only.  Evidence gathered from the current tree (branch cut from `main`).

```text
# no product compile required; docs-only
git diff --stat
```

Did not run `npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run build` because no TypeScript or app files changed.

## Next Steps & Blockers

See audit §6 and §9.  P0: unify SEC document builder (parsed text); gate merge on `retrieveContextDetailed` production eval; pass `asOf` on chat + desk.  Blocker for worker-scale backfill: do not enable `SEC_INGEST_WORKER_ENABLED` until I1 lands.

## Zero-Code Findings

The stack is mature (demand-first ingest, two-phase commits, extractive highlights, consumption-filtered attribution).  The dangerous gaps are path divergence (worker HTML vs incremental text; harness `retrieveFusedContext` vs production `retrieveContextDetailed`) and unwired safety modules (memory decay, vector lifecycle, chat/desk omitting `asOf`).  Full evidence: `docs/audits/2026-08-17-rag-learning-recall.md`.
