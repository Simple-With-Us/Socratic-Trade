# ST In-App MiniMax Model: MiniMax-M3 To MiniMax-M3.1-Flash

**Date:** 2026-10-21
**Seat:** CLAUDE
**Linear:** ST-4574
**Branch:** `claude/st-4574-minimax-m3-1-flash`

## 1. Context & Objective

Owner asked for Socratic.Trade to use `MiniMax-M3.1-Flash` as its MiniMax model.  The 2026-10-20 owner ruling already moves all fleet MiniMax use to that model, and the repo's CI (Kody autofix) was already on it.  What remained was the in-app product model, which was still `MiniMax-M3`.

## 2. Changes Made

The catalog row `minimax-m3` is replaced by `minimax-m3.1-flash`.  The old spellings stay as aliases, so a persisted selection resolves to the new row instead of falling through to the unknown-model path.

- `src/lib/llm-model-catalog.ts`: display slug `minimax-m3.1-flash`, OpenRouter slug `minimax/minimax-m3.1-flash`, native slug `MiniMax-M3.1-Flash`, aliases `minimax-m3` and `minimax/minimax-m3` (the catalog lookup is case-insensitive, so `MiniMax-M3` resolves too), predecessors `minimax-m3` and `minimax-m2.7`.
- `src/lib/llm-usage.ts`: new price row `minimax-m3.1-flash` at $0.15 in and $0.60 out per 1M tokens.  The `minimax-m3` price ($0.30 and $1.20, the 512K-and-under tier) moved into the "retired" block so historical usage rows keep pricing at what they cost.
- `app/console/lib/models.ts`: display name `MiniMax M3.1 Flash`.  The old `MiniMax M3` names are gone because `modelDisplayName` canonicalizes through the catalog first and could never reach them.
- Tests (all offline): `test/llm-model-catalog.test.ts`, `test/llm-provider.test.ts`, `test/llm-cache-usage.test.ts`, `test/llm-request.test.ts`, and the fixtures in 12 other files that used the old slugs.  The new cases are listed under Verification State.
- Docs: this note, `STATUS.md`, `PLAN.md`, `docs/manager-model-options.md`.

## 3. Decisions & Trade-offs

**Prices.**  MiniMax pay-as-you-go page (platform.minimax.io, read 2026-10-21): `MiniMax-M3.1-Flash` is $0.15 input, $0.60 output, $0.015 cached input.  The existing 0.1x cache-read multiplier in `estimateLlmCostUsd` reproduces the cached rate exactly.  There is no long-prompt surcharge.  M3 was $0.30 and $1.20 up to 512K input tokens and doubled above that.

**Native slug is verified live.**  `POST https://api.minimax.io/v1/chat/completions` with model `MiniMax-M3.1-Flash` returned HTTP 200 and echoed `MiniMax-M3.1-Flash` as the served model, using the operator key (status and model only, no key or content printed).

**OpenRouter slug is the paid id, and OpenRouter cannot serve it yet.**  On 2026-10-21 OpenRouter listed only `minimax/minimax-m3.1-flash:free` (zero price, served through BYOK).  A call to `minimax/minimax-m3.1-flash` returned 404 with the message that the free launch period ended on Oct 22 and the `:free` variant is retired, while its own `/endpoints` list for the paid id was empty.  The `:free` variant still answered at the time of the check.  I chose the paid id because it is the id OpenRouter names as the successor and it carries the list price the usage table assumes.  A `:free` slug would route production trading prompts to a variant OpenRouter has announced is retired.  Consequence: an account on the OpenRouter route would get a 404 on MiniMax until OpenRouter publishes the paid endpoint.  Production MiniMax accounts are not on that route (see section 4), and the rotation planner only picks models present in the account's OpenRouter `/models/user` list.

**Stored `minimax-m3` selections follow the alias.**  `resolveLlmEndpoint` looks the stored string up in the catalog at call time, so no data migration is needed and nothing is written to the database.  Cost of the alias: `canonicalModelId` merges old M3 usage, latency and P&L rows onto the `minimax-m3.1-flash` display slug, so Results and Model Stats no longer separate the two models.  `getPredecessorModelIds` skips predecessors that canonicalize to the model itself, so listing `minimax-m3` as a predecessor does not double count.  `minimax-m2.7` still rolls forward as before.

**Not changed.**  `src/lib/llm-request.ts` (the `^(minimax|muse)-` reasoning headroom regex) and `src/lib/code-cli.ts` (the `^minimax-` owner-only gate) both match `minimax-m3.1-flash` and `MiniMax-M3.1-Flash`, and tests now pin that.  The 8,000-token reasoning headroom and 360 second wall were measured on M3 (see `2026-10-19-minimax-muse-reasoning-budget.md`) and have not been re-measured on M3.1 Flash.

**Code CLI route.**  An owner on the Code CLI route now sends `MiniMax-M3.1-Flash` to the broker.  The broker contract says it must never substitute the CLI's default model, so the installed MiniMax Code CLI has to accept that id.  Not tested here (broker access is owner-only).

**Settings picker.**  A stored `minimax-m3` is no longer a curated option on Strategy, so the picker shows it as a custom id even though it runs M3.1 Flash.  Left as is, the same way earlier renames behaved.

## 4. Production Accounts (read-only check)

Source: `GET /api/ops/snapshot` through `scripts/fetch-prod-ops-snapshot.sh`, read 2026-10-21 at about 8:00pm.  Nothing was written to production.

| Account | Role | Stored model | Provider reported |
|---|---|---|---|
| Sandbox (`becad9f1`, active, 6 failed runs in a row) | Green | `minimax-m3` | minimax |
| Alpaca Paper (`4f7c96ba`, close_only) | Red Team | `minimax-m3` | minimax |
| Agentic, Roth IRA, Alpaca Standard, Tradier, Public (all halted) | both | `__rotate__` | openrouter |

Production has `llm_route_minimax = "native"` (set 2026-10-15), so MiniMax calls go straight to `api.minimax.io` with the native slug.  `test/llm-provider.test.ts` now reproduces that shape (native route, both keys present) for the Green and the Red role: a policy holding `minimax-m3` resolves to provider `minimax`, URL `https://api.minimax.io/v1/chat/completions`, model exactly `MiniMax-M3.1-Flash`.  So Sandbox Green and Alpaca Paper Red move to M3.1 Flash automatically on deploy, and no setting needs changing.  Rotating accounts pick up the new row through the catalog pool; all five are halted.

Not visible in the snapshot: `llmFallbackModels` per account.  If any fallback list holds `minimax-m3`, it resolves the same way.

## 5. Verification State

Commands run in the lane, with `cd` inline:

- `npx tsc --noEmit`: see the result in the PR.
- `npx vitest run` over the 18 touched and related files: see the result in the PR.
- `npx eslint` over the touched source and test files: 0 errors, 45 warnings, all `no-explicit-any` and unused-variable warnings that were already there.

New test cases: every M3 spelling resolves to the new row on the display, OpenRouter and native columns; `getPredecessorModelIds` returns `minimax-m3` and `minimax-m2.7`; the stored `minimax-m3` resolves to `MiniMax-M3.1-Flash` on the native route, the OpenRouter route and the explicit `openrouter/` form; the production-shaped native route for Green and Red; price rows for M3.1 Flash (including a `:free` suffix, which must not fall back to the M3 prefix price) and for historical M3 rows.

## 6. Next Steps & Blockers

- When OpenRouter publishes the paid `minimax/minimax-m3.1-flash` endpoint, one call confirms the OpenRouter route.  Until then OpenRouter-routed MiniMax calls fail with a 404.
- Re-measure completion tokens and latency of M3.1 Flash through the Green proposer before relaxing the reasoning headroom or the 360 second wall.
- Sandbox has failed 6 runs in a row; it is a separate issue from the model name, so watch whether the switch to the faster model clears the streak.
