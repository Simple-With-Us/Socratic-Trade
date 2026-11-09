# 2026-07-03 — Owner sovereign-design decisions + Manager-model options

> **CORRECTION (2026-07-03, later the same day):** Decision 1 below was mis-recorded — the owner
> said they did not understand the drawdown-breaker question as asked. The confirmed decision is
> **ADVISORY, not hard-halt**, and broader: *"nothing is hard except which account to work in"* —
> every guardrail line is an advisory input the agent weighs itself, with every deviation logged as
> a receipt for review/coaching; the account boundary is the only absolute. See
> `docs/rollouts/2026-07-03-guardrail-philosophy-correction.md`. Decisions 2–4 stand.

## Summary
Docs-only. The owner answered the four open decisions that gated the next major build, and this lane
records them and adds a cross-provider model-evaluation doc for the strategist ("Manager") role.

## Decisions (owner, 2026-07-03)
1. ~~**Drawdown circuit-breakers → HARD-HALT** during the live soak (halt autonomous trading on a
   drawdown-threshold breach until manually re-armed).~~ **CORRECTED → ADVISORY** (see banner above).
2. **Stop-losses → PROMPT-EXPECTED** — the LLM proposes stops and policy validates; NOT schema-forced.
   (Owner chose flexibility over the fail-closed default.)
3. **Manager model tier → EVALUATE cross-provider, not a single pick** — owner wants an options list
   (incl. DeepSeek for cost) and to measure how each performs.
4. **Draft PR #315 → CLOSED** (superseded by the console port).

## Why
Decisions 1–2 unblock the live-execution hardening build; 3 is answered with a decision doc + an
empirical A/B plan rather than a guess; 4 clears the stale draft.

## Files
- `docs/manager-model-options.md` (new) — cross-provider comparison (Anthropic/OpenAI/Google/DeepSeek/
  xAI/Qwen), July-2026 pricing (Anthropic from the bundled `claude-api` reference; others via web
  search, sources cited), per-run cost envelope for this low-volume/output-heavy workload, the
  capabilities that actually matter for a trading strategist (structured-output adherence first), and a
  recommendation: A/B a 3-model shortlist in paper mode and rank by realized per-model P&L using #334's
  `proposedByModel`. OpenAI-compatible endpoints make provider-swapping a base-URL change, not a new
  integration each.
- `docs/EFFORT-LOG.md` — #336 → Completed; decisions recorded; live-execution hardening Blocked → Ready.
- `STATUS.md`, `docs/rollouts/2026-07-03-owner-decisions-manager-model.md` — this note.

## Verification
- Docs-only change (no source touched). Full gate run to honor the pre-commit protocol: `npx tsc
  --noEmit`, `npm run lint`, `npm test`, `npm run build` — all green (see commit).

## Follow-ups (next build, now unblocked)
- **Live-execution hardening:** ~~hard-halt drawdown breakers (default-on during soak)~~ **advisory
  drawdown awareness (corrected)** — breach state fed to the agent as prompt context + owner
  receipt/notification, no halting — plus prompt-expected stop-loss expectation in the strategist
  prompt/schema with policy validation.
- **Manager-model A/B:** wire the shortlist via the OpenAI-compatible path + Anthropic path, run in
  paper mode, compare per-model Results (pair with the "per-model hit rates on Results" follow-up).
- Pricing in the options doc is July-2026 and should be re-verified before committing a budget.
