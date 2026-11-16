# 2026-08-10 (~1:55am CT) — align trace tags to the OpenRouter Classifiers-beta taxonomy

## Context & Objective

The owner's OpenRouter "Socratic Trade Classifier" (Classifiers beta, Gemini 3.5 Flash Lite,
id 0e50fa11-...) tags every generation along `subsystem`/`feature`/`environment` by reading our
`trace.*` request metadata, with owner-configured defaults: feature → "assistant-chat" when
`trace.feature` is absent/unrecognized, subsystem → "strategy". ST's call sites emit INTERNAL
tag names (the `llm_usage.context` vocabulary: "strategy", "learning-review",
"proposal-revalidation", ...) that are not taxonomy values, and the `service` fell back to a
literal "llm" — so the OpenRouter dashboard showed the decision engine's spend (~$85/30d) as
"assistant chat". The in-app assistant actually cost $0.27 all-time.

## Changes Made

- `src/lib/llm-call.ts` — `resolveClassifierTaxonomy()`: single-choke-point translation applied
  inside `applyOpenRouterClassifierEnrichment` (every OpenRouter path routes through it,
  including `buildLlmRequestBody`, vector-db embed/rerank, search-fusion, query-deconstruct,
  chat, salience). Feature map: strategy→green-team, strategy-bear→green-team (Bear argues
  within the Socratic proposal debate — owner can flip to red-team if preferred),
  strategy-tuning→tuning, learning-review→framework-review, outcome-postmortem→post-mortem,
  proposal-revalidation→revalidation, rag-query-deconstruct→search-fusion-mmr; identity for
  already-exact values. Subsystem derives from the resolved feature (strategy/rag/chat/memory),
  an explicit caller service wins only when it IS a taxonomy value, and the off-taxonomy "llm"
  filler can no longer be emitted. Unknown features pass through verbatim (visible in the
  console) instead of vanishing into the assistant-chat default. Internal ledger names unchanged.
- `test/usage-compliance-classifier.test.ts` — full mapping table test (14 cases) + unknown-tag
  passthrough + explicit-service precedence; two pre-existing pins updated to the taxonomy.

## Verification State

- `npx vitest run test/usage-compliance-classifier.test.ts` — 20/20; `npx tsc --noEmit` clean.
  Full gates via `scripts/land.sh`.

## Next Steps & Blockers

- Console-side proposal for the owner (their config, not code): change the feature default from
  "assistant-chat" to a new explicit "unknown" value (and subsystem default from "strategy" to
  "unknown") so instrumentation gaps surface instead of masquerading as real features; optionally
  add "monitoring" features (health probes) if those ever route through OpenRouter.
- After deploy, confirm on the OpenRouter Activity view that new generations classify as
  green-team/red-team/etc. and assistant-chat drops to ~zero.
