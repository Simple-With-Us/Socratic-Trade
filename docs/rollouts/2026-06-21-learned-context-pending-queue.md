# 2026-06-21 — Learned-context risk-tier confirmation queue

## Summary

Built the deferred second slice of the crossover-learning loop: the **risk-tier confirmation
queue**. Previously `ingestLearned` (`src/lib/learned-context/store.ts`) AUDIT-DROPPED every
candidate classified above `'fact'` (tier `'risk'` / `'strategy-directive'`). Now, candidates from
**autonomous / ingest** producers above `'fact'` are routed to a per-user human confirmation queue
(`learned_context_pending`) instead of being dropped, and on **approval** they are applied SAFELY.

## The safety line (do not cross)

An approval **NEVER** auto-derives or auto-writes a numeric policy change. `setPolicy` /
`validatePolicy` remain reachable **only** via the explicit human `PUT /api/policy`. No code path in
the approve flow imports or calls `setPolicy`. The store header and the approve route both document
this; a test asserts `getPolicy()` is byte-identical across a `risk` approve.

Approve semantics by tier:

- **`strategy-directive`** → APPEND a bounded, attributed block to the user's STRATEGY PROMPT via
  `setStrategyPrompt` (read current → append, never wholesale-replace). The block is delimited and
  keyed by the pending id:
  `\n\n<!-- AI-LEARNED {id} {YYYY-MM-DD} -->\n{value}\n<!-- /AI-LEARNED -->`.
  Re-approving the same id REPLACES just that id's block (idempotent; no duplication). This is
  approved guidance TEXT; it does not touch numeric policy limits.
- **`risk`** → PROMOTE to an advisory `learned_context` row via `insertLearnedContext`
  (scope `private`, `riskTier 'risk'`, origin preserved). It becomes soft DATA the LLM reads (already
  governed by the shipped conviction-size cap). The human approval IS the gate; any actual numeric
  risk-limit change remains a separate manual action in Risk settings.

Chat-origin candidates above `'fact'` are still **hard-capped**: dropped + audited, never queued. A
chat message can never create a pending risk item.

## Why

The fact-tier slice intentionally dropped everything above `'fact'` because there was no human
review path. This slice adds that path so genuinely useful risk/strategy learnings from autonomous
runs and ingestion can be surfaced for confirmation — without ever letting free text silently move a
numeric risk limit.

## What changed

### DB (`src/lib/db.ts`)
- New `learned_context_pending` table (migration + index pattern mirrors `learned_context`):
  user-scoped, `origin` CHECK(`chat|autonomous|ingest`), `risk_tier` CHECK(`risk|strategy-directive`),
  `status` CHECK(`pending|approved|rejected`) DEFAULT `pending`, `classifier_reason`, `created_at`,
  `resolved_at`. Index `(user_id, status, created_at)`.
- Helpers (all ownership-scoped, `WHERE user_id = ?`): `insertPendingLearnedContext(row)`,
  `listPendingLearnedContext(userId, status='pending')`, `getPendingLearnedContext(id, userId)`,
  `setPendingLearnedContextStatus(id, userId, status)` returning `boolean` (`changes > 0`).

### Types (`src/lib/types.ts`)
- `LearnedContextPendingStatus`, `LearnedContextPendingRow` (`riskTier` is
  `Exclude<LearnedContextRiskTier, "fact">`).

### Store (`src/lib/learned-context/store.ts`)
- `ingestLearned`: PII still drops first. Chat-origin above `'fact'` still drops+audits (hard-cap
  preserved). `autonomous`/`ingest` above `'fact'` now INSERT a pending row (status `pending`) and
  audit `learned_context.pending`. `IngestLearnedResult` extended with `pending` / `pendingId` so
  callers see dropped vs pending. Fact tier unchanged.
- New `applyApprovedPending(pending)` (safety-critical) — directive append vs risk advisory promote;
  never calls `setPolicy`.
- New `mergeStrategyDirectiveBlock(prompt, id, value, dateIso)` — append-not-replace, idempotent by
  id (exported for unit testing the invariant).

### API
- `GET  /api/learned-context/pending` — list this user's pending rows.
- `POST /api/learned-context/pending/[id]/approve` — ownership-404 gate → `applyApprovedPending` →
  status `approved` + `resolved_at` → audit `learned_context.approve`.
- `POST /api/learned-context/pending/[id]/reject` — ownership-404 gate → status `rejected` +
  `resolved_at` → audit `learned_context.reject`; applies nothing.
- All routes resolve identity via `resolveRequestUserId` and mirror the existing `[id]`-route
  ownership-404 pattern.

### Classifier note
`classifyRiskTier` (unchanged) is fail-closed and emits only `'fact'` | `'risk'`. The
`'strategy-directive'` tier is one the queue can HOLD and APPROVE but that a producer sets
explicitly — the classifier never auto-derives a prompt rewrite. The directive-approve test seeds a
`strategy-directive` pending row directly to reflect this real producer path.

## Files

- `src/lib/db.ts` — pending table, index, type imports, CRUD helpers.
- `src/lib/types.ts` — `LearnedContextPendingStatus`, `LearnedContextPendingRow`.
- `src/lib/learned-context/store.ts` — ingest routing, `applyApprovedPending`,
  `mergeStrategyDirectiveBlock`, extended `IngestLearnedResult`.
- `app/api/learned-context/pending/route.ts` — GET list.
- `app/api/learned-context/pending/[id]/approve/route.ts` — POST approve.
- `app/api/learned-context/pending/[id]/reject/route.ts` — POST reject.
- `test/learned-context-pending.test.ts` — new test file (6 tests).
- `test/learned-context.test.ts` — updated the one prior assertion that expected an **autonomous**
  risk candidate to be `risk_dropped`; it is now QUEUED (`dropped === null`, `pendingId` set, still
  NOT written to the brain). The chat hard-cap test is unchanged.

## Verification

```
cd /Users/jay/apps/wt-queue
npx tsc --noEmit   # clean (exit 0)
npm test           # 80 files, 710 tests pass (incl. 6 new pending-queue tests)
```

New tests assert: autonomous risk → pending (not dropped); chat risk → still dropped, never queued;
strategy-directive approve appends the AI-LEARNED block (pre-existing prompt preserved) and re-approve
of the same id does not duplicate; risk approve creates a `learned_context` row while `getPolicy()`
stays byte-identical (no numeric mutation) and the prompt is untouched; reject applies nothing;
ownership isolation (user B gets 404 / no-change on user A's row, and the status helper refuses the
wrong owner).

## Follow-ups / risks

- No UI yet for the queue — these are backend routes + store/db only. A dashboard surface to
  list/approve/reject is the natural next slice.
- `'strategy-directive'` pending rows currently require a producer to set the tier explicitly (the
  classifier never emits it). If/when a producer starts emitting prompt-rewrite directives, no schema
  change is needed.
- Approving a `risk` candidate promotes it to the advisory store as-is (no superseding/reconcile vs
  an existing same-subject advisory row); acceptable for this slice since approval is human-gated.
