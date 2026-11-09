# 2026-07-16 — Exit-strategy intelligence: expert-panel design doc (CLAUDE)

## Summary

Docs-only. Landed `docs/design/exit-strategy-intelligence.md` — the synthesized findings of
an owner-directed 13-agent expert-panel workflow (4 code-mapping readers → 4 domain-expert
position papers → 4 cross-critique debate rounds → 1 verifying synthesis) on how the system
should elicit, adapt, and execute exit strategies for longs/shorts/options. No code changed.

## Why

Owner request (verbatim intent): have market/trading experts and LLM prompt/ML/RAG/coding
experts debate whether there is a better way to request/obtain stop strategy and parameters
in trade proposals, whether exit strategies need intelligent modification for held positions
as market/ticker conditions change, and how to ensure proper execution of exit strategies.

## Key findings (full detail in the design doc)

- Exit plumbing is strong (idempotent synthetic fires, lot-keyed plans, teardown queues) but
  exit POLICY is fire-and-forget: plans are write-once at fill, invisible to the LLM on
  re-review, and the owner has no per-position stop editor.
- Three verified enforcement tail holes: (1) bad-tick filter permanently disarms trailing
  stops after a >10% gap (`synthetic-stops.ts:30,114,528`); (2) fixed/atr plans have NO
  tick-cadence enforcement (excluded from the synthetic monitor, `synthetic-stops.ts:406,440`
  — hourly proactive checks only; worst case: atr plan + Tradier market entry = bracket
  silently dropped, no broker lane); (3) `halted` scheduler state skips the stop monitor
  entirely.
- Shorts are about to go live with the thinnest protection tier: every broker-held stop lane
  filters `quantity > 0` (`broker-protective-stops.ts:492-499`).
- OCC option positions are filtered out of the book entirely (`tradier.ts:499-506`) — an
  assigned contract is invisible to every exit layer.
- 11 consensus recommendations ranked + 7 contested points ruled + an explicit
  what-NOT-to-do list (e.g. no second price-trigger machine beside the stop system; no
  LLM numerics honored before the Exit Contract migration persists resolved distances).
- Phased roadmap: A (make today's promises true — gap fix, halted protection, prompt
  visibility, honesty notes, options visibility) → B (persisted parameterized Exit Contract,
  fixed/atr tick lane, short buy-stop broker lane BEFORE live shorts) → C (`exitRevisions[]`
  hold-and-retune verb, structured invalidation/time exits, clamped numeric elicitation,
  counterfactual exit ledger).

## Files

- `docs/design/exit-strategy-intelligence.md` (new)
- `docs/rollouts/2026-07-16-exit-strategy-expert-panel.md` (this note)
- `docs/EFFORT-LOG.md` (Planned rows for Phases A/B/C, unassigned)
- `STATUS.md` (snapshot entry)

## Verification

Docs-only change; `npx tsc --noEmit` run clean as a sanity check. The `verify` CI gate
runs the full trio on the PR regardless.

## Follow-ups

- Phase A items (A1 gap-deadlock fix, A2 protectWhileHalted, A3 prompt visibility, A4
  honesty notes, A5 options visibility) are each S/S-M, independently shippable, and left
  UNASSIGNED on the effort board for the first agent to claim.
- Phase B is the money-path phase (Exit Contract migration) — frontier-tier adversarial
  review per the fleet rule when it starts.
- The owner should read "Contested points" ruling 7 (protection-while-halted semantics)
  since it deliberately changes what `halted` means, and the design doc flags it for a
  design note at implementation time.
