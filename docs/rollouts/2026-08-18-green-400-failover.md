# 2026-08-18 — Green 400 must actually fail over

Rebased onto `origin/main` `13b60747` after #2830 merged (PR #2831 was CONFLICTING/DIRTY).  Docs auto-merged.  Did not recreate the PR.  Did not touch #2812 health-gate, #2840 rag-embed chunking, or #2841 notification history.  Runtime unchanged: 400 failover-eligible, exhausted suffix counts stored calls, terra not first Green pick.

Earlier rebase onto `12e8dcd` after #2812: sole conflict `docs/phase-7-strategy.md`.  Kept rag-embed soft-degrade (must not 503).

## Context & Objective

First Green after #2829 is live (`6429d984`) still failed.  Jay's receipt: Paper `PA33IDTHMFK9` run `7f5890a5-bc21-4474-87eb-9b595de04ed1` (2026-08-18T19:33:02Z–19:38:29Z) picked `gpt-5.6-terra` → `openai/gpt-5.6-terra`, HTTP 400 "Provider returned error" (881ms), then "Failover chain exhausted (3 Green Team endpoints)" after ONE stored `llm_call_latency`.  Red `deepseek-reasoner` never ran.  The #2829 account-miss sentence did not fire.  Do not rewrite that 400 copy.  Make Green actually complete.

## Changes Made

#2829 added 404/403 to `isFailoverLlmStatus` and left 400 out.  The exhausted sentence used `plannedBullAttempts.length` (implicit rotation seats) even when those seats were never called.  `openai/gpt-5.6-terra` is on public `/models` (414-row catalog check 2026-08-18) but OpenRouter 400s it as "Provider returned error"; fail-open still lets it win first pick because it is first in `MODEL_ROTATION_POOL`.

- 400 is failover-eligible for the next Green/Red seat.  It is not a same-model retry (`isRetryableLlmStatus(400)` stays false) and not an account-allowlist miss.
- The exhausted suffix cites stored Green attempts only.  "3 endpoints exhausted" is legal only after 3 stored calls.
- Terra is demoted from first Green pick when any better seat remains.  Implicit fallbacks lead with Gemini Flash / Mistral Medium class seats that #2829 unblocked.
- Red stays eligible after a Green 400 because Green now leaves that seat for the next stored call instead of aborting the run.

Touched files:

- `src/lib/llm-request.ts`
- `src/lib/strategy.ts`
- `src/lib/model-rotation.ts`
- `test/llm-request.test.ts`
- `test/llm-errors.test.ts`
- `test/model-rotation.test.ts`
- `test/strategy-llm-failover.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-08-18-green-400-failover.md`

## Decisions & Trade-offs

- Did not revert #2829 or #2800.
- Did not rewrite the user-facing 400 sentence.  Structured OpenRouter copy stays "OpenRouter error 400: Provider returned error."
- Did not drop terra from the rotation pool.  It can still be a later failover or a Red pick.  It must not be the first Green pick while Gemini Flash / Mistral Medium class seats exist.
- Public `/models` lists `openai/gpt-5.6-terra`, so a catalog-only filter would still pick it.  Live 400 is the unservable signal.
- 400 failover can burn more than one request-shape bug if every seat rejects the same body.  That is accepted: the live failure was a per-seat provider error, and Gemini/Mistral must be called.

## Verification State

```bash
# Public catalog still lists terra (so availability alone cannot demote it):
curl -sS https://openrouter.ai/api/v1/models | python3 -c "import json,sys; ids=[m.get('id','') for m in json.load(sys.stdin).get('data',[])]; print('terra', [i for i in ids if 'terra' in i])"
# terra ['openai/gpt-5.6-terra-pro', 'openai/gpt-5.6-terra-pro:batch', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-terra:batch']

npm test -- test/llm-request.test.ts test/llm-errors.test.ts test/model-rotation.test.ts
# 65 passed
npm test -- test/strategy-llm-failover.test.ts
# 6 passed (includes 400 records N calls + Red still runs)
npm run lint   # 0 errors, 769 grandfathered warnings
npx tsc --noEmit  # clean
```

Required coverage: (a) 400 is failover-eligible and not a same-model retry; (b) exhausted suffix is empty after 1 stored call and names N after N>1; (c) 400 "Provider returned error" is not an account miss; (d) terra is not first pick when Gemini Flash / Mistral Medium seats remain; (e) a Green 400 records the next stored call and still invokes Red.

`xcodebuild` was not run (no `ios/**` product change; Linux VM).

## Next Steps & Blockers

Watch the next Paper Green after merge: stored `llm_call_latency` rows must match the claimed chain, and Red must run when a later Green seat serves.  If terra 400s as a later fallback, keep it demoted; do not reword the 400.

## Zero-Code Findings

Hypothesis confirmed: #2829's leave-for-next set was 404/403 only, and the "3 endpoints" count was planned seats.  Terra is listed on public `/models`; the 400 is an upstream "Provider returned error", not a missing slug.
