# Red Team (single-adversary consolidation) — Resolved Open Decisions

**Date:** 2026-07-01
**Status:** Decisions settled. This is a **decision-capture / relay note** from the
orchestration session. The **authoritative** design spec is
`docs/single-adversary-consolidation.md` (§9 lists these as open); that spec is
owned and edited by a **separate working session**, so this note does not modify
it — §9/§3.7/§5/§7 there should be updated to match the resolutions below.

## Context

The strategy engine's adversarial "Red Team" review is being consolidated from
**two** LLM passes (the in-flow "Bear" inside `proposeTrades` + the standalone
post-sizing `debateProposal` in `src/lib/red-team.ts`) into **one** hardened
post-sizing Red Team, per `docs/single-adversary-consolidation.md`. That spec
left four open decisions (O1–O4). They are now resolved.

## Resolved decisions

### O1 — Naming: **keep "Red Team"**
No rename. Retain all existing identifiers and UI labels: `redTeamLlmModel`,
`redTeamProvider`, `debateProposal`, the `RED_TEAM_*` constants, and the "Red
Team" UI copy. **No DB-value migration.** The spec's "Adversary Review"
placeholder is dropped.

### O2 — Coverage: **run on every opening; remove the conviction gate**
The Red Team reviews **all** risk-adding opening trades (`buy` / `short`); the
`confidenceScore >= 80` conviction gate is **removed** (drop
`tuning.redTeamConvictionThreshold` + its Settings slider). Rationale: it should
always matter; cost is trivial (~$0.07/day). **Implementation detail (not a
choice):** run the per-opening calls **concurrently** so universal coverage does
not lengthen the per-user scheduler-lock hold.

### O3 — Failure policy + visibility: **never fail silently; ERROR ≠ REJECT**
Distinguish the Red Team **erroring out** from the Red Team **rejecting**:

- **Error / unavailable** — the Red Team *could not run* (timeout, JSON parse
  failure, schema-invalid response, missing key, provider error). → **Fail
  closed:** route the trade to the human as a pending / manual proposal, across
  **all** execution modes, **including `test/local`**.
  - It **must be loudly and explicitly flagged** — a prominent **"RED TEAM
    FAILED"** badge/label on the pending-approval card **and** the notification
    (do **not** overwrite the `pending_approval` title), with the reason
    **persisted** into `decision.reasons` so it survives the run. The user must
    instantly see that the safety check **did not run** — it must never look like
    a routine manual-approval proposal.
- **Reject** — the Red Team *ran* and returned `reject`. → Normal,
  working-as-intended reject path; **no "failed" flag** (this is distinct from an
  error).
- Consistency: the Red Team sets `requiresHumanReview` across **all** failure
  modes (error / timeout / unparseable).

### O4 — Independence / single-provider: **fail-closed when unconfigured; never silent fallback**
- **Hard rule:** adversary model ≠ proposer model (exact match forbidden).
- Different **company/provider** is the **strong, warned default** but is **not**
  hard-forced: a single-provider user may use a *different model from the same
  provider*, with a Settings warning that this only *partially* achieves
  independence.
- A **blank** `redTeamLlmModel` **and no second-provider key** → treat as
  **unconfigured → fail closed** (route to human). It must **never** silently
  fall back to the Green/proposer model — that silent fallback is the
  "(fallback)" behavior that motivated this work.

## Ownership / next step

- Authoritative spec + implementation: owned by a **separate session**
  (`docs/single-adversary-consolidation.md`). Update its §9 to mark O1–O4
  resolved, and §3.7/§5/§7 to carry the explicit **"RED TEAM FAILED"** flag per
  O3.
- This session (orchestration) is running the Learning-Loop (B) and RAG (C)
  workstreams + a multi-expert design/expansion review; it does **not** touch the
  Red Team money-path code.
