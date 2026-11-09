# 2026-06-26 — Langfuse offline eval / regression harness (items #6 + #7)

Branch `agent/claude-langfuse-evals`. Improvement-program items #6 (offline eval/regression) + #7 (6-provider
answer-quality suite).

## Summary
A hermetic, offline answer-quality eval harness that catches prompt / RAG / provider regressions.

- `scripts/eval/dataset.ts` — 15 seed cases across the app's LLM task families (chat, quote, alert, order
  incl. a jailbreak-no-execute case, watchlist add/view, kb hit + no-result, positions, advice/disclaimer,
  alerts view). Each case: `{ id, task, input, expectations[] }` supporting deterministic checks + an optional
  rubric for the LLM judge.
- `scripts/eval/score.ts` — 6 deterministic scorers (contains, notContains, regex, notRegex, equals,
  jsonShape) returning `{pass, score, detail}`; plus an LLM-judge scorer that is a no-op when
  `EVAL_JUDGE_API_KEY` is absent (so offline runs never hit the network).
- `scripts/eval/run-offline.ts` — replays the dataset through the **real** provider registry
  (`chatProviderForModel` / `llmForModel` from `src/lib/chat/llm.ts`). Default mode uses the repo's `MockLLM`
  (hermetic, no keys); real-provider replay across all six (openai/anthropic/xai/gemini/mistral/deepseek) is
  opt-in via `EVAL_REAL_PROVIDERS=1`. Langfuse logging is gated on `LANGFUSE_PUBLIC_KEY` presence (reuses
  `withLlmGeneration` from `observability.ts`, which is already a passthrough when unconfigured). Prints a
  per-provider summary table; exits non-zero below a 0.75 threshold.
- `test/eval-offline.test.ts` — 49 hermetic tests (temp-SQLite `beforeAll`, no network/keys) covering the
  scorers and the end-to-end MockLLM run.
- `package.json` — `"eval:offline": "npx tsx scripts/eval/run-offline.ts"` (matches the repo's existing
  `npx tsx` script-runner convention).

## Why
Items #6/#7 — an automated regression net for the LLM layer. Pure tooling; not a money path. No feature flag
(it's a script); real-provider/Langfuse calls are env-gated so the default is fully offline.

## How (model-tiered subagent team)
Built by a workflow team (run `wf_f4910fa5-9f9`): all sonnet (recon → design → implement → adversarial
review). Review verdict: `implementsSpec/correct/tscGreen/testsGreen` all true; provider/model routing
verified (grok→xai, ministral→mistral, etc.); MockLLM outputs align with every dataset expectation. The only
flagged issue was a staging artifact (deliverable files initially untracked), since resolved.

## Verification
- `npx tsc --noEmit` clean; `npx vitest run test/eval-offline.test.ts` → 49 pass.
- `npm run eval:offline` → `Overall pass=15/15 score=100.0% threshold=75% — PASS`.
- Full `tsc → test → build` trio via `scripts/land.sh`.

## Follow-ups
- Real-provider replay (`EVAL_REAL_PROVIDERS=1`) and Langfuse dashboards are wired but require keys — run in a
  keyed env / CI secret context to get the cross-provider answer-quality matrix on a schedule.
- Expand the dataset over time (more RAG-grounded kb cases) as the regression net proves its value.
