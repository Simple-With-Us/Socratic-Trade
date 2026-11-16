# 2026-07-06 - typed-retrieval-status

## Summary

- Added a typed retrieval-status receipt that distinguishes *why* a RAG/episodic retrieval pass
  came back the way it did — `no_memory` (real zero-match) vs `lookup_failed` (missing keys or a
  thrown pipeline error) vs `budget_skipped` (daily LLM/RAG budget already over) vs `degraded`
  (R16 per-run budget trip — non-empty, rerank/hybrid skipped) vs `ok` — instead of every one of
  these collapsing to an indistinguishable `[]`/non-empty result for callers.
- `src/lib/vector-db.ts`: new exported `RetrievalStatus` union; a new optional
  `RetrieveOptions.onStatus?: (status: RetrievalStatus) => void` callback invoked exactly once
  before `retrieveContextDetailed` returns, at each of the four points that already computed this
  classification internally (previously Sentry-only warning strings): the `isOverLlmBudget`
  short-circuit (`budget_skipped`), the missing-Pinecone/Voyage-key short-circuit and the
  missing-index / malformed-query-embedding / outer-catch paths (all folded to `lookup_failed`),
  the final zero-result vs non-empty-under-`shouldDegradeForBudget` split (`no_memory` /
  `degraded` / `ok`). A throwing callback is swallowed (`reportRetrievalStatus`) so it can never
  affect retrieval. Also added a thin `retrieveContextDetailedWithStatus(...)` convenience wrapper
  returning `{ chunks, status }` for callers that don't want to wire their own callback. Every
  existing caller that doesn't pass `onStatus` is byte-identical (no new work performed, no new
  audit/log volume).
- `src/lib/experience-memory.ts`: new exported `ExperienceRetrievalStatus` union
  (`flag_off | budget_skipped | lookup_failed | ok_empty | ok`) and a new `status` field on
  `ExperienceRetrievalResult`. `retrieveDecisionExperiences` now wires `onStatus` into its
  `retrieveContextDetailed` call (captured via an object-holder ref, not a bare `let`, to avoid a
  TS control-flow-narrowing false-positive across the intervening `await`), maps vector-db's
  status onto this caller's own union (`budget_skipped`/`lookup_failed` pass through; everything
  else collapses to this caller's own `ok`/`ok_empty` split based on `injected.length`, since
  same-run-neighbor exclusion can empty out an otherwise-`ok` vector-db result), and returns
  `flag_off` when `experienceMemoryEnabled()` is false or `lookup_failed` from its own outer catch.
- `src/lib/strategy.ts`: both the filings-block and the episodic-block RAG passes now capture a
  typed status row (`{symbol, status, reason?}`) — per-symbol for the filings pass, one `PORTFOLIO`
  row for the cross-symbol episodic pass — into a new `ragRetrievalStatusRows` accumulator, with a
  fallback row recorded in each block's outer `catch` for the (defensive) case an earlier statement
  throws before any `onStatus`/`retrieveDecisionExperiences` call fires. Persisted via a new
  `audit("rag_retrieval_status", { runId, rows }, userId, connectedAccountId)` call placed right
  after the episodic block, alongside (not replacing) the existing `experience_retrieval` audit.
  Also threaded into `buildSocraticDecisionCase(...)` as an additive `ragRetrievalStatus` input.
- `src/lib/types.ts`: additive optional `ragRetrievalStatus?: { symbol: string; status: string;
  reason?: string }[]` field on `SocraticDecisionCase` — a typed persistence home for the receipt.
  **Persistence only — not rendered anywhere.** `socratic-memory.ts`'s `summarizeRag` (which
  renders the fixed "No retrieved memory/context was attached to this case." string regardless of
  cause) was deliberately left untouched: Memory-panel rendering is Codex keepout in this task.
- `src/lib/socratic-runtime.ts`: `buildSocraticDecisionCase` accepts the new optional
  `ragRetrievalStatus` input and copies it onto the built case (append-only, additive spread —
  absent when not supplied, so every other caller/fixture is unaffected).

## Why

- Ground-truth triage found the classification logic already existed at four points inside
  `retrieveContextDetailed` but only surfaced as Sentry warning strings — every caller (the
  filings block, `experienceMemoryEnabled`'s episodic block) saw an indistinguishable empty or
  non-empty result with no way to tell "nothing relevant exists" apart from "the RAG pipeline is
  broken" apart from "we're over budget today" apart from "quality was silently lowered this run."
  Making the *existing* classification typed and observable (rather than inventing new
  classification logic) was both the minimal-risk and minimal-diff option.
- Chose the `onStatus` callback + thin wrapper over changing `retrieveContextDetailed`'s return
  type: the function is called from many sites across the codebase expecting `RetrievedChunk[]`;
  an optional additive callback keeps every existing call site byte-identical while still giving
  new/opted-in callers (experience-memory.ts, strategy.ts) a typed receipt.
- Advisory-only by construction (owner philosophy, `AGENTS.md`): the status is read-only telemetry
  attached to the run/decision-case audit trail. It is never consulted to gate, alter, retry, or
  drop retrieval/proposals — verified by inspection (no `if (status === ...)` branch anywhere
  touches chunk selection) and by the dedicated test asserting chunk selection is unchanged
  regardless of status.
- Kept the `vector-db.ts` diff deliberately minimal/localized per the task's explicit coordination
  note: the sibling lane `claude/persist-candidate-pool` also edits `retrieveContextDetailed` in
  the same file. Only touched (a) the four early-return classification points (one line each) and
  (b) the final success/catch paths — no refactor of the return pipeline, no restructuring of
  `rankPool`/`embedAndMatchOneQuery`/the multi-query fan-out.

## Files

- `src/lib/vector-db.ts` — `RetrievalStatus` type, `RetrieveOptions.onStatus`,
  `reportRetrievalStatus` helper, wired at the 4 classification points +
  `retrieveContextDetailedWithStatus` wrapper.
- `src/lib/experience-memory.ts` — `ExperienceRetrievalStatus` type, `status` field on
  `ExperienceRetrievalResult`, wired through `retrieveDecisionExperiences`.
- `src/lib/strategy.ts` — `ragRetrievalStatusRows` accumulator, wired into the filings block's
  `retrieveContextDetailed` call and the episodic block's `retrieveDecisionExperiences` result,
  persisted via a new `rag_retrieval_status` audit, threaded into `buildSocraticDecisionCase`.
- `src/lib/socratic-runtime.ts` — `buildSocraticDecisionCase` accepts + copies
  `ragRetrievalStatus`.
- `src/lib/types.ts` — additive `SocraticDecisionCase.ragRetrievalStatus` field.
- `test/rag-retrieval-status.test.ts` — new, network-free (mocked Pinecone/Voyage/db/llm-budget),
  11 cases covering all 5 statuses (`budget_skipped`, `lookup_failed` via missing keys / thrown
  query / missing index, `no_memory`, `ok`, `degraded`), the throwing-callback safety guarantee,
  the byte-identical-when-omitted guarantee, and the `retrieveContextDetailedWithStatus` wrapper.
- `STATUS.md`, `docs/EFFORT-LOG.md` — dated section / In Progress row for this lane.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run test/rag-retrieval-status.test.ts test/rag-retrieval-eval.test.ts` — 21/21
  passed (11 new + 10 pre-existing eval-harness cases, confirming the eval harness's byte-identical
  behavior claim still holds).
- Additional focused runs (not part of the required verification but done to de-risk touching
  shared files): `test/experience-memory.test.ts`, `test/socratic-runtime.test.ts`,
  `test/socratic-memory.test.ts`, `test/strategy-episodic-injection.test.ts`,
  `test/strategy-rag-quickwins-wiring.test.ts`, `test/run-strategy-offline.test.ts` — 26/26
  passed. The full `vector-db-*`/`rag-*` family (15 files) — 171/171 passed.
- The `land.sh` gate ran the full suite at land time: `npx tsc --noEmit` clean, full `npm test`
  2711/2711 passed across 272 files, and `npm run build` clean (confirmed via the PR's
  `verify`/`verify-hosted` CI logs).

## Follow-ups

- The typed status is persistence-only right now (`SocraticDecisionCase.ragRetrievalStatus`); no
  UI surfaces it. A future task could render it in the Memory panel (Codex keepout for this task,
  so deliberately left undone here) to replace the fixed "No retrieved memory/context..." string
  with an honest per-cause message.
- `ExperienceRetrievalResult.status` maps vector-db's five-way status down to a caller-specific
  four/five-way union (`flag_off | budget_skipped | lookup_failed | ok_empty | ok`) — vector-db's
  `no_memory` and `degraded` both collapse into this caller's `ok`/`ok_empty` split based on
  `injected.length` (post same-run-exclusion). This is intentional (the experience-memory caller's
  own "was anything actually injected" question is more actionable than vector-db's internal
  degrade-vs-empty distinction for this particular consumer) but worth knowing if a future reader
  expects a 1:1 pass-through.
- Coordination: `claude/persist-candidate-pool` (sibling lane) also touches
  `retrieveContextDetailed` in `vector-db.ts`. This diff was kept intentionally minimal/localized
  (early-return points + a thin status output only) so whichever lane merges second has a small,
  mostly non-overlapping diff to reconcile.
