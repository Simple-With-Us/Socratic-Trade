# 2026-08-20 — `prompt-trust-boundary`: untrusted content can no longer reach the trusted strategy prompt

## Context & Objective
Tranche-1 cluster from the 2026-08-18 review (issues #2915, #2943), closing `coach-06`, `llm-04`, `llm-13`, `coach-05` and `llm-18`.  The strategy prompt is the one fully-trusted region the model reads as owner intent.  Content derived from the internet (a coach-pasted URL), or paraphrased by an LLM, could reach it verbatim and unlabelled — so a fetched page carrying an instruction-hijack idiom could read as an instruction from the owner.

The fix is **containment and provenance, not friction**.  The owner ruling forbids adding approval ceremony; nothing here gates or blocks the owner's own text, and no existing off-switch or default was changed.

## Changes Made
- `src/lib/learned-context/directive-block.ts` (NEW) — one pure leaf holding `isOwnerAuthoredLearnedSource`, `containDirectiveValue`, `directiveProvenanceLabel` and `buildStrategyDirectiveBlock`, so the block that lands and the block the console previews are built by the same code.
- `src/lib/learned-context/store.ts` — **the trust boundary now lives at the sink.**  `mergeStrategyDirectiveBlock` takes a REQUIRED `source` (plus optional `origin`), runs containment itself, and returns `{ prompt, contained }`.  A caller can no longer write an unscanned directive into the trusted prompt by forgetting a helper — the old shape trusted the caller to call two helpers in the right order, which is the same hazard this cluster exists to remove.
- `src/lib/chat/coach-learning.ts` — `captureUrlLesson` contains the fetched page AT INGEST.  A page carrying a real instruction-like span is dropped, audited (`learned_context.drop`, reason `prompt_injection`, with pattern ids and quarantined excerpts) and the owner gets an honest receipt.  Clean pages behave exactly as before.
- `src/lib/learned-context/semantic-gate.ts` — when no chat credential resolves and `getLLM` hands back a `MockLLM`, that previously-silent "the second layer did not actually run" condition is now a deduped `semantic_gate_mock_llm_fallback` audit row.  Behavior is unchanged: it still degrades to the keyword tier and still never blocks.
- `app/api/chat-history/route.ts` — the forgeable, unauthenticated `POST` handler is deleted (GET and DELETE kept), with a comment recording why it must not return.  Every web and iOS caller was re-grepped: nothing called it.
- `src/lib/proposal-revalidation.ts` — `originalRationale` is contained before being sent, and the reviewer system prompt opens with an explicit data-not-command clause naming that field.
- `src/lib/learned-context-queue-helpers.ts`, `app/console/lib/learned-context.ts`, `app/console/lessons/learned-context.tsx` — the console preview builds from the same leaf, so "the exact block approval appends to your strategy prompt" stays true, and non-owner-authored items say so.
- Tests: `test/prompt-trust-boundary.test.ts` (NEW, 8 cases) and extensions to `test/learned-context-queue-ui.test.ts`, `test/learned-context-pending.test.ts`.

## Decisions & Trade-offs
- **Owner text is never touched.**  Containment keys on PROVENANCE, not on the text: `source === "owner-coach"` passes through byte-for-byte with no scan, so an owner may legitimately write "You must now avoid meme stocks" and their words are preserved.
- `learningReviewMode: "decide"` auto-apply and the `learningReviewEnabled` default are untouched.  The second review round established that this is an owner-made choice with an existing off-switch; re-gating it would be the paternalism the product philosophy forbids.
- The drop trigger is `quarantinedExcerpts.length > 0`, not `status !== "clean"`, so a bare length truncation can never masquerade as an injection.

## Verification State
- `npm run lint` 0 errors (769 pre-existing warnings) · `npx tsc --noEmit` clean · `npm test` **7146 passed** / 51 skipped, 0 failures · `npm run build` exit 0.
- Failing-first: the new test file predates every source edit; 7 of its 8 cases failed against unmodified source (the 8th is the deliberate no-regression control — a clean article is still captured).  Verbatim example: `expected '7b2bad91-…' to be null` — a learned_context row WAS written, with the injection text verbatim.
- An independent skeptic read the real diff and returned SOUND_WITH_NITS.  Its main point — move the boundary to the sink rather than rely on one caller — is implemented here, and the required-`source` signature was proven to work by making the one stale 4-argument call site fail to compile.

## Next Steps & Blockers
- Follow-up noted by the reviewer, out of this cluster's scope: `src/lib/chat/orchestrator.ts` still feeds raw `liveWinRate`/`paperWinRate` into the coach's tool context with no sample count, so the model can tell the owner "your win rate is 0%" for an account that has never closed a trade.  Belongs with `pnl-basis-labels`.
