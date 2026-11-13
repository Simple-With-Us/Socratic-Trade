# ST In-App MiniMax Model: MiniMax-M3 To MiniMax-M3.1-Flash

**Date:** 2026-10-21 (catalog); **2026-11-07** PR #4998 Kody follow-ups merged with `main` (ST-4589 retired-catalog shape)
**Seat:** CLAUDE (+ CURSOR review fixes)
**Linear:** ST-4574
**Branch:** `claude/salvage-minimax-m3-1-flash` / `cursor/pr-4998-review-fixes-21a3`

## 1. Context & Objective

Owner asked for Socratic.Trade to use `MiniMax-M3.1-Flash` as its MiniMax model.  The 2026-10-20 owner ruling already moves all fleet MiniMax use to that model, and the repo's CI (Kody autofix) was already on it.  What remained was the in-app product model, which was still `MiniMax-M3`.

## 2. Changes Made

**Offered row:** `minimax-m3.1-flash` (native `MiniMax-M3.1-Flash`, OpenRouter `minimax/minimax-m3.1-flash`, $0.15 in / $0.60 out per 1M).

**ST-4589 follow-up (merged on `main`, reconciled in PR #4998):** `minimax-m3` is a **retired** catalog row (`RETIRED_LLM_MODEL_CATALOG`), not an alias on the M3.1 row.  A stored `minimax-m3` policy keeps its own OpenRouter wire id (`minimax/minimax-m3`) and native id (`MiniMax-M3`) until the owner picks `minimax-m3.1-flash`.  That keeps the OpenRouter `/models/user` availability gate honest: a listed `minimax/minimax-m3` must not read as proof that `minimax-m3.1-flash` is servable.

**PR #4998 / Cursor follow-ups (2026-11-07):**

- `src/lib/model-rotation-pin.ts`: pin validation uses alias-aware `catalogEntryFor` / `displaySlugFor`, so a persisted `minimax-m3` rotation pin is not rejected as `malformed_pin` when the display slug left the live pool.
- `test/openrouter-model-availability.test.ts`, `test/model-rotation-pin.test.ts`, `test/llm-provider.test.ts`: regression coverage for the availability gate, retired pins, and M3.1 native routing.
- This rollout note: removed internal account identifiers; corrected predecessor roll-forward attribution (see §3).

Touched files in the original ST-4574 work remain: `src/lib/llm-model-catalog.ts`, `src/lib/llm-usage.ts`, `app/console/lib/models.ts`, manager docs, and the offline test matrix listed in §5.

## 3. Decisions & Trade-offs

**Prices.**  MiniMax pay-as-you-go page (platform.minimax.io, read 2026-10-21): `MiniMax-M3.1-Flash` is $0.15 input, $0.60 output, $0.015 cached input.  The existing 0.1x cache-read multiplier in `estimateLlmCostUsd` reproduces the cached rate exactly.  M3 stays priced in the table for historical rows.

**Native slug is verified live.**  `POST https://api.minimax.io/v1/chat/completions` with model `MiniMax-M3.1-Flash` returned HTTP 200 and echoed `MiniMax-M3.1-Flash` as the served model (status and model only, no key or content printed).

**OpenRouter slug is the paid id, and OpenRouter cannot serve it yet.**  On 2026-10-21 OpenRouter listed only `minimax/minimax-m3.1-flash:free` (zero price, BYOK).  A call to `minimax/minimax-m3.1-flash` returned 404 while the paid endpoint list was empty.  Default MiniMax route is **OpenRouter** (`src/lib/llm-route.ts`); production MiniMax trading accounts that use **native** (`llm_route_minimax = "native"`, set 2026-10-15) reach `api.minimax.io` with `MiniMax-M3.1-Flash` when the policy stores `minimax-m3.1-flash`.  Accounts on the default OpenRouter route get a 404 on new M3.1 picks until OpenRouter publishes the paid endpoint.

**Predecessor stats.**  `getPredecessorModelIds` returns `entry.predecessors` verbatim.  The filter that drops a predecessor whose canonical id equals the model itself (and drops cross-class predecessors) lives in `src/lib/model-stats.ts` when building same-class estimates — not in `getPredecessorModelIds`.  With the retired-row layout, `minimax-m3.1-flash` has an empty predecessor list on the offered row; M3 history stays on the `minimax-m3` retired slug.

**Code CLI route.**  `resolveLlmEndpoint` forwards `nativeSlugFor(model)` to the broker (`MiniMax-M3.1-Flash` for `minimax-m3.1-flash`).  Fleet recall (2026-10) records MiniMax Code default `minimax/MiniMax-M3.1-Flash`; broker acceptance is owner-verified, not exercised from this repo.

## 4. Production Accounts (read-only check)

Source: `GET /api/ops/snapshot` through `scripts/fetch-prod-ops-snapshot.sh`, read 2026-10-21.  Nothing was written to production.

| Account label | Role | Stored model | Provider reported |
|---|---|---|---|
| Sandbox (active, repeated failed runs at time of check) | Green | `minimax-m3` | minimax |
| Alpaca Paper (`close_only`) | Red Team | `minimax-m3` | minimax |
| Agentic, Roth IRA, Alpaca Standard, Tradier, Public (halted at time of check) | both | `__rotate__` | openrouter |

Production has `llm_route_minimax = "native"` for the MiniMax trading accounts above.  A stored `minimax-m3` continues to call `MiniMax-M3` on that route until the owner changes the policy to `minimax-m3.1-flash` (retired row, not silent alias migration).  New picks use `minimax-m3.1-flash` and native `MiniMax-M3.1-Flash`.

## 5. Verification State

Commands run on branch `cursor/pr-4998-review-fixes-21a3` after merging `origin/main`:

- `npx tsc --noEmit`
- `npx vitest run test/model-rotation-pin.test.ts test/openrouter-model-availability.test.ts test/llm-provider.test.ts test/llm-model-catalog.test.ts test/llm-cache-usage.test.ts`
- Full `npm test` and `npm run build` left to CI `verify`

## 6. Next Steps & Blockers

- When OpenRouter publishes the paid `minimax/minimax-m3.1-flash` endpoint, one call confirms the OpenRouter route.
- Owner migration of Sandbox / Alpaca Paper from stored `minimax-m3` to `minimax-m3.1-flash` when ready (optional; retired row keeps M3 working).
- Re-measure M3.1 Flash completion tokens and latency before relaxing reasoning headroom or the 360s wall (`docs/rollouts/2026-10-19-minimax-muse-reasoning-budget.md`).
