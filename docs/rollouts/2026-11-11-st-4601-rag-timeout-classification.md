# ST-4601 — Classify strategy RAG deadline timeouts

## Context & Objective

Production strategy runs were spending another 15s per symbol after the retrieval deadline fired, and each abort was reported twice at error level.  SOCRATIC-TRADE-2G is "RAG retrieval failed".  SOCRATIC-TRADE-1X is "OpenRouter embed connection failed" with `failureClass` hard.  Both are the caller-side deadline (`strategy RAG retrieval timed out`), not a provider outage.  This change classifies that abort as a timeout and stops the rest of the run from waiting on RAG.

## Changes Made

- `src/lib/rag-retrieval-deadline.ts` — `isStrategyRagRetrievalTimeout` recognizes the deadline flag and the wrapped message.
- `src/lib/db-health.ts` — caller-timeout rows are soft and classified `timeout`, so they do not paint the lane STOPPED.
- `src/lib/vector-db.ts` — the deadline reports "RAG retrieval timed out" at warning with fingerprint `rag/retrieval-timeout`.  It does not send "connection failed" or `failureClass` hard.  The embed retry loop throws before backoff when the caller signal is aborted or the error is the deadline.
- `src/lib/rag/embed-resilience.ts` — a deadline does not advance the embed circuit breaker.
- `src/lib/rag/retrieval-pressure.ts` — a deadline still counts toward retrieval backoff.
- `src/lib/strategy.ts` — after the first deadline in a run, later symbols skip RAG.  One warning includes the skipped count.  The episodic pass is skipped for that run too.  Facts cards still build.  Empty chunks stay the continue path.
- `ragSentryCooldownKey` includes a caller fingerprint when it leaves the lane issue, so a deadline warning cannot suppress a transient-network warning on the same lane.  Covered in `test/rag-sentry-cooldown-key.test.ts`.
- Tests: `test/rag-deadline-timeout-classification.test.ts`, `test/strategy-rag-timeout-skip.test.ts`, and a deadline case in `test/embed-resilience.test.ts`.

## Decisions & Trade-offs

- Did not raise `RAG_QUERY_IO_DEADLINE_MS`.  Did not change order placement, sizing, prompts, or strategy settings.
- A real `ECONNRESET` stays on the existing transport path and is still `hard` once the blip window has elapsed.
- Symbols already in flight in the same retrieval batch can still finish.  Later batches skip.  The run log is one line, not one warning per symbol.
- The timeout Sentry event uses its own fingerprint so it does not keep grouping into the provider-outage issues.

## Verification State

```bash
npx tsc --noEmit
npx eslint src/lib/rag-retrieval-deadline.ts src/lib/db-health.ts src/lib/vector-db.ts src/lib/strategy.ts src/lib/rag/embed-resilience.ts src/lib/rag/retrieval-pressure.ts test/rag-deadline-timeout-classification.test.ts test/strategy-rag-timeout-skip.test.ts test/embed-resilience.test.ts
npx vitest run test/rag-deadline-timeout-classification.test.ts test/strategy-rag-timeout-skip.test.ts test/embed-resilience.test.ts test/rag-retrieval-deadline.test.ts test/retrieval-pressure.test.ts test/health-transient-network-classification.test.ts test/strategy-rag-quickwins-wiring.test.ts
```

`npx tsc --noEmit` is clean.  `npm run lint` reports 0 errors (867 grandfathered warnings).  The focused vitest command above passed (51 tests).  Full `npm test` is 10190 passed, 41 skipped, and 17 failed.  Those failures are outside this change: GitHub credentials are missing, and several suites expect no provider key while this VM already has one.  None of them are in the RAG deadline or strategy skip files.  `npm run build` completed.

## Next Steps & Blockers

- Open the PR against `main`.  Do not merge and do not enable auto-merge.  Jay merges after `verify` is green.
- GB-Trader already holds the Linear claim.  This seat did not take it.

## Zero-Code Findings

- The deadline error keeps `name: "Error"` plus `__deadlineTimeout`, so `isAbortOrTimeoutError` does not match it.  That is why it was filed as a hard connection failure.
