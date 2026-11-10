# 2026-08-31 - SiliconFlow base URL fix (platform mismatch, not a dead key)

## Context & Objective

The golden-eval lane reported the handoff-file `SILICONFLOW_API_KEY` as "expired" (401).
The owner said the key is valid — and they were right.  SiliconFlow runs TWO separate
platforms with independent accounts/keys: `api.siliconflow.com` (international) and
`api.siliconflow.cn` (China).  Live probe: the fleet key returns 200 on `.com` and 401 on
`.cn`.  The app hardcoded `.cn` at all three call sites, so the SiliconFlow lane could
never authenticate with the only key the fleet has.

## Changes Made

- `src/lib/siliconflow-base.ts` (NEW): `siliconflowBaseUrl()` — env-overridable
  `SILICONFLOW_BASE_URL`, default `https://api.siliconflow.com` (the platform the fleet's
  key belongs to), trailing-slash-stripped.
- `src/lib/vector-db.ts` (embeddings :2480-ish, rerank :2651-ish) and
  `src/lib/rag/search-fusion.ts` (:48): the three hardcoded `.cn` URLs now use the
  helper.
- `test/siliconflow-base.test.ts` (4 tests).

## What this actually unblocks (verified against the live .com catalog)

- **Rerank lane: FIXED.**  `.com` serves `Qwen/Qwen3-Reranker-8B` — exactly the model
  `rag/rerank-policy.ts` requests for the siliconflow route.  With the fleet key, that
  route now authenticates and the model exists.
- **Embeddings: still not servable by SiliconFlow with this key.**  `.com`'s embedding
  catalog is Qwen3-Embedding only — `BAAI/bge-m3` (the corpus's embed space) is a
  CN-platform model.  The lane's failure class changes from 401 to a clean 400
  model-not-found and still falls through to OpenRouter, same as before — no regression,
  and do NOT switch embed models to "fix" this: a different embedding model is a
  different vector space (the Voyage lesson).
- **Local golden eval: still blocked on an embed route.**  71/71 queries failed embed
  with `.com` 400 model-not-found (after this fix removed the 401).  Options, owner's
  pick: (a) hand off a DeepInfra key (serves BAAI/bge-m3, OpenAI-compatible, pennies) —
  new provider account = owner-only per the key rules; (b) local Ollama serving bge-m3
  with a `SILICONFLOW_BASE_URL=http://localhost:11434/v1` override and a model alias —
  free, no new key, synergizes with the owner's local monitor-model plan, small
  quantization drift noted (conservative: under-reports recall); (c) leave the gate to
  production telemetry (prod embeds via per-user OpenRouter work fine).

## Verification State

- Live probes: `.com /v1/models` 200 with the fleet key (77 models; rerank model
  present; no bge-m3), `.cn` 401.  Key value never printed; length-and-status checks
  only.
- `npx tsc --noEmit` clean; `npx vitest run test/siliconflow-base.test.ts` 4/4 green;
  full gate via `scripts/land.sh` on this PR.

## Next Steps & Blockers

- Owner: choose the golden-eval embed route ((a)/(b)/(c) above).
- Prod note: the siliconflow lane only activates where a `SILICONFLOW_API_KEY` resolves
  (Connections or env).  Whether to enable it in prod for rerank is a separate knob/key
  decision — not changed here.

## Replaced Docs

None.
