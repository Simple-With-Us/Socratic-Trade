# Green Bull strict schema fix (`green-request-schema`)

## Context & Objective

Part II cluster `green-request-schema` from `docs/reviews/2026-08-18-full-app-expert-review.md`: Bull strict JSON schema listed `exitPlan` in `properties` but omitted it from `required`, causing OpenAI-family Green seats to 400 before generation.  json_object transports (DeepSeek, Gemini schema fallback) had no post-parse completeness gate on the happy path.

## Changes Made

- Added `exitPlan` to `BULL_PROPOSAL_REQUIRED_KEYS` so `required` matches `properties` under `additionalProperties: false` + strict mode.
- Exported `bullAttemptUsesJsonObjectTransport` and route happy-path `json_object` parses through `filterRepairedProposals`.
- Added `exitPlan` string/null type check in `filterRepairedProposals`.

**Files touched:**
- `src/lib/strategy.ts`
- `test/strategy-hardening.test.ts`
- `test/strategy-candidate-enforcement.test.ts`

## Decisions & Trade-offs

- Kept `BULL_PROPOSAL_REQUIRED_KEYS` as the single source for both schema `required` and the completeness gate (per existing doc comment) rather than deriving from an inline `properties` object — minimal diff, same invariant.
- `exitPlan` stays nullable in schema; required means key presence only, consistent with `bracketTakeProfit` / `stopPlan`.
- Post-parse gate applies only on `json_object` transports (DeepSeek, Gemini unsupported-schema fallback), not strict `json_schema` paths where the provider enforces shape.

## Verification State

```bash
npm run lint          # 0 errors
npx tsc --noEmit      # clean
npm test -- test/strategy-hardening.test.ts test/strategy-candidate-enforcement.test.ts  # 104 passed
```

## Next Steps & Blockers

- Merge PR; auto-deploy to production on `main`.
- After deploy, verify a gpt-* Green run no longer 400s; grep `llm_call_latency` for status 400 by model since 2026-08-16 to confirm blast radius cleared.

## Zero-Code Findings

None.
