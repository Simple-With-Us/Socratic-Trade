# 2026-08-17 — Strategy-run model slugs + lease-lost mislabel

## Context & Objective

Owner screenshot of All Messages (8:34–8:38am CT, 2026-08-17): Green Team failed on two
OpenRouter models in the same rotation, and Pinecone / OpenRouter rerank paged
"connection failed" in the same minute the site was down for 1m23s.  Goal: make the
next rotation call a valid Mistral slug, stop nano 400s that are not a bad slug, and
stop labeling local dispatch-lease loss as a vendor outage.

## Changes Made

- `normalizeOpenRouterModelId` now wires Mistral Medium to `mistralai/mistral-medium-3-5`
  and remaps any leftover `mistralai/mistral-medium-3.5` period form.  OpenRouter
  `get-model` confirms the dash id exists and the period id 404s.
- Every OpenRouter LLM body now sets `provider.require_parameters: true` and
  `allow_fallbacks: true`.  GPT-5.4 nano's slug is correct (`openai/gpt-5.4-nano`); the
  OpenAI endpoint is status -2 and does not advertise `max_completion_tokens`, while
  Azure does.  Requiring advertised parameters skips the incompatible endpoint.
- `withRagApiHealth` treats `ProviderDispatchLeaseLostError` like a local-process
  fault: no pinecone/rerank health-failure row and no `provider_degraded` push.

Touched files:

- `src/lib/llm-provider.ts`
- `src/lib/llm-call.ts`
- `src/lib/db-provider-dispatch.ts`
- `src/lib/vector-db.ts`
- `test/llm-provider.test.ts`
- `test/llm-call.test.ts`
- `test/local-db-fault-classification.test.ts`
- `test/provider-dispatch-durability.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-17-strategy-run-model-slugs.md`

## Decisions & Trade-offs

- Did not hard-ignore the OpenAI provider forever.  `require_parameters` is the
  precise filter; when OpenAI advertises `max_completion_tokens` again it can
  re-enter the pool.
- Did not raise the 2-minute dispatch lease.  The 13:34Z pages were a process
  restart, not a slow query.  Last-2d Pinecone Sentry besides this event is the
  already-parked write-unit fuse.
- Catalog display still says "mistral-medium-3.5" as a product name.  Only the
  wire slug changed.

## Verification State

```bash
npx vitest run test/llm-provider.test.ts test/llm-call.test.ts \
  test/local-db-fault-classification.test.ts test/provider-dispatch-durability.test.ts
```

59 passed / 4 files.  Full lint / tsc / test / build gate via `scripts/land.sh` before merge.

## Next Steps & Blockers

- Land via `scripts/land.sh`.  Auto-deploy on merge to `main`.
- After deploy, the next Green rotation should no longer 400 on Mistral.  Nano
  should route to Azure unless that endpoint also degrades.
- No owner action on Pinecone trial / WU fuse.

## Zero-Code Findings

- UptimeRobot down 1m23s at 13:34Z is the same instant as both lease-lost pages
  (shared Sentry `trace_id`).  Not a Pinecone outage.
- OpenRouter embed "connection failed" at 08:37Z landed 18s after that container's
  `app_start_time` — another restart, not an embed-provider outage.
- Congress.trade SSE and fleet CI Sentry issues in the same 24h window are out of
  this ST money-path scope.
