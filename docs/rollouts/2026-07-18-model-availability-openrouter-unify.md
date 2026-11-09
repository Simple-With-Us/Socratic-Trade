# 2026-07-18 — Model availability unified on the OpenRouter credential (consolidation note)

> **Provenance:** this note was reconstructed on 2026-07-19 (CLAUDE seat). The owner's handoff
> list linked this exact path on `main`, but no session ever authored or pushed it — the file
> existed nowhere (not on main, any branch, GitHub code search, or any local worktree; the
> empty session branch `claude/model-availability-rollout-b3adaf` sits at main with zero
> commits, consistent with a session that planned the note and died before writing it). The
> underlying WORK was all landed and deployed by 2026-07-18; this note fills the documentation
> gap so the link resolves and the program has one summary. Details of the reconciliation:
> `docs/rollouts/2026-07-19-four-handoff-conquest.md`.

## Summary

"Model availability" — which models a user can pick, save, rotate to, and actually get served —
is now keyed on the **single OpenRouter credential** everywhere in production, instead of
per-model native-family keys. One curated catalog, one credential rule, one canonical model
identity. The program landed across six PRs (all merged to `main` and auto-deployed):

| PR | What | Rollout note |
|----|------|--------------|
| #1703 | Universal OpenRouter routing + clean-names optimization (Antigravity) | (none — see followups note) |
| #1705 | OpenRouter UI models + global JSON repair | `2026-07-17-openrouter-metadata-codex-autofix.md` |
| #1716 | Canonical model identity — benchmark continuity + Usage by-model merge | `2026-07-17-usage-canonical-model-merge.md` |
| #1736 | One shared model-identity canonicalizer | `2026-07-17-model-identity-shared-helper.md` |
| #1733 | Post-#1703 Codex findings: P1 Claude reasoning via OpenRouter (unified `reasoning` param, explicit thinking budget), `xai/`→`x-ai/` slug normalization, billing cooldowns pinned to the credential lane | `2026-07-18-openrouter-codex-followups.md` |
| #1737 | Rotation eligibility + policy save-gate on the OpenRouter credential via the shared `modelCredentialService(model)` helper | `2026-07-18-openrouter-exclusive-eligibility.md` |

Supporting: `2026-07-16-openrouter-model-catalog.md` (curated catalog),
`2026-07-17-openrouter-model-stats-canonicalization.md` (server-side stats identity),
`2026-07-18-openrouter-credit-health-signal.md` + PR #1770 (prepaid-credit balance on
`/api/health` for external monitoring, after the 2026-07-18 credit-exhaustion incident —
`2026-07-18-worktree-cleanup-voyage-rca.md`).

## The unified rule

`modelCredentialService(model)` (`src/lib/llm-provider.ts`) returns `"openrouter"` in
production (native family only under `NODE_ENV=test`, keeping native-key fixtures working).
`resolveLlmEndpoint`, `eligibleRotationPool` (`src/lib/model-rotation.ts:161`), and both policy
save-gates (`app/api/policy/route.ts`, green + red) all route through it — an OpenRouter-only
account gets the full curated pool and can save any curated model; the three consumers cannot
drift.

## Verified state at reconstruction (2026-07-19, main @ 7be71390)

- `eligibleRotationPool` gates on the OpenRouter credential (the "4th finding" deferred in
  `2026-07-18-openrouter-codex-followups.md` was closed by #1737 — the deferral note predates
  the fix landing; both merged 2026-07-18).
- Prod healthy; `/api/health` `openrouterCredits` reporting (75 total / 25.31 used at check).

## Still genuinely open (deferred, tracked)

1. **Billing all-cooling planner policy** (`src/lib/llm-provider-cooldown.ts`
   `planLlmProviderAttempts`): when every lane cools from a shared-credential BILLING cooldown,
   the "attempt anyway, least-recently-failed first" fallthrough still retries the chain on the
   dead key. Distinguishing billing (skip/hold) from transient (attempt-anyway) is a deliberate
   policy change to a money-path-adjacent invariant — **owner/maintainer decision required**,
   not a regression.
2. **Overview "COST BY MODEL" tile** could reuse the Usage page's canonical-identity
   aggregation (`2026-07-17-usage-canonical-model-merge.md`) — low-effort cleanup, deferred.

## Verification

Docs-only reconstruction; no code changed. Claims grounded in the merged PRs above, the cited
rollout notes, and direct reads of `src/lib/model-rotation.ts` / `src/lib/llm-provider.ts` on
`main @ 7be71390`.
