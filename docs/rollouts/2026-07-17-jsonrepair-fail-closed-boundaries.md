# 2026-07-17 — jsonrepair healing: fail-closed boundaries for safety-critical parse sites (CLAUDE on PR #1696)

## Summary

Cap-reset pickup of the stalled `agent/local-response-healing` lane (PR #1696), addressing the
four unresolved Codex threads. The PR's core idea (local, deterministic `jsonrepair` instead of
a remote healing LLM) is kept; what changes is WHERE repair is allowed to apply:

1. `extractJsonPayload` (src/lib/llm-call.ts) no longer repairs globally — repair is **opt-in**
   via `extractJsonPayload(text, { repair: true })`, default OFF. Global repair converted
   fail-closed handling into fail-open on every safety gate: a TRUNCATED Red Team reply like
   `{"verdict":"approve"` repairs into a well-formed approval; a truncated revalidation
   `withdraw` repairs into a proposal withdrawal.
2. **Red Team** (src/lib/red-team.ts): strict parse (no repair) — truncated/malformed replies
   stay `unavailable` (fail-closed). NEW ambiguity guard: a reply carrying more than one
   `"verdict":` block (sequential objects, single-quoted variants, multi-element conflicting
   arrays) is unavailable, never resolved to whichever block is extracted first. The #1091
   single-element bare-array unwrap is preserved.
3. **Proposal revalidation** (src/lib/proposal-revalidation.ts): strict parse — malformed output
   keeps taking the catch path that leaves the pending queue untouched.
4. **Strategy tuning** (src/lib/strategy-tuning.ts): strict parse — a truncated tuning payload
   stays a failed read instead of carrying partial weights toward the auto-apply lane.
5. **Bull proposals** (src/lib/strategy.ts) — the one generative opt-in: strict parse first;
   on failure re-extract with `repair: true`, then gate every recovered proposal through a new
   `filterRepairedProposals` completeness check (all `BULL_PROPOSAL_REQUIRED_KEYS` present +
   non-empty rationale/tradeThesisTag + finite confidenceScore). Partial objects produced by
   repairing a truncated response are dropped (audited via
   `strategy_bull_repaired_partial_dropped`) instead of reaching sizing where defaults would
   fabricate the missing judgment. The schema literal now spreads the same
   `BULL_PROPOSAL_REQUIRED_KEYS` constant so gate and schema cannot drift.

## Why

Codex proved the same defect from four angles (threads r3600319751/57, r3600408783/84/86,
r3600458580): jsonrepair proves SYNTAX, never completeness or intent. On gates whose safe
direction is "unavailable" (Red Team, revalidation, tuning), any repair is a fail-open
conversion. Owner philosophy: harden correctness — a bug must not place (or approve) an order
the user didn't intend.

## Files

- src/lib/llm-call.ts (opt-in repair + doc comment)
- src/lib/red-team.ts (strict parse + ambiguity guard)
- src/lib/proposal-revalidation.ts, src/lib/strategy-tuning.ts (intent comments; strict by default)
- src/lib/strategy.ts (Bull repair opt-in + `filterRepairedProposals` + shared required-keys const)
- test/llm-call-json-payload.test.ts (default-strict + opt-in repair coverage)
- test/red-team.test.ts (truncated-approval fail-closed; 3 ambiguity variants)
- test/strategy-hardening.test.ts (completeness-gate coverage)
- STATUS.md, docs/EFFORT-LOG.md, this note

## Verification

- `npx tsc --noEmit` clean
- `npx vitest run test/red-team.test.ts test/llm-call-json-payload.test.ts test/redteam-failure-routing.test.ts` — 52/52
- `npx vitest run test/strategy-hardening.test.ts` — 79/79
- Full `npm test` + `npm run build` + `npm run lint` before push (see PR checks)

## Follow-ups

- PR #1677 (OpenRouter migration) still references the deleted remote `response-healing.ts` on
  its own branch — reconciling that is part of the #1677 pickup, next in this session's queue.
- The AG lane resumes ownership of #1696 on return per the pickup-seat protocol.
