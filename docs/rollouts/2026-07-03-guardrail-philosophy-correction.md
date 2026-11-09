# 2026-07-03 — Guardrail philosophy: owner correction ("nothing is hard except the account")

## Summary

Docs-only correction of a mis-recorded owner decision. #337 recorded "drawdown
circuit-breakers → HARD-HALT" as an owner decision; the owner later said they
**did not understand that question as asked**, and stated the actual philosophy
(verbatim): **"nothing is hard anything except which account to work in."**

Clarified with the owner via a structured question the same day; confirmed
option: **"Agent decides, logs everything."** Concretely:

- **Every guardrail line is advisory** — drawdown, spend caps, sizing, and the
  rest are inputs the agent weighs with its own judgment. It may proceed past
  them on its own; nothing halts autonomous trading mechanically.
- **Every deviation is a receipt** — proceeding past a guardrail line must be
  logged/audited and surfaced in the UI as a reviewable, coachable decision
  ("deviations, receipted" — not silent, and not "rules bent" either).
- **The account boundary is the only absolute** — the agent operates solely in
  the account(s) it is designated to work in. That is the one hard rule.

This is coherent with the parallel owner-directed lane removing "paper-as-default
/ Test-mode paternalism" from the agent rules (PR #339,
`claude/kill-paper-default-rules`) and with the Socratic Trade product thesis
(the Codex `app/design/socratic-trade` mockup's "overrode drawdown sell trigger"
receipt is the *intended* behavior, with copy adjusted to "deviation, receipted").

## Why

The wrong record was already steering the next build: the "live-execution
hardening" item was scoped as "hard-halt breakers, default-on during soak." A
second mis-build would have been expensive. Lesson recorded: sovereign-design
questions put to the owner must be phrased in plain language and the recorded
answer read back for confirmation.

## Files

- `docs/rollouts/2026-07-03-owner-decisions-manager-model.md` — correction
  banner; decision 1 struck through; hardening follow-up re-scoped.
- `docs/EFFORT-LOG.md` — decision 1 corrected in place (per the log's own
  correct-don't-delete rule); "Ready to build" hardening scope updated
  (advisory awareness, no halting); changelog entry.
- `STATUS.md` — new entry.
- This note.

## Verification

Docs-only. Gate to run at landing time (deferred while the observed-holiday
test fix is in flight on another lane): lint / tsc / test / build.

## Follow-ups

- The live-execution hardening build must implement **advisory drawdown
  awareness** (breach state as strategist prompt context + owner
  notification/receipt + coaching trail), not halting.
- ~~Wash-sale gating~~ **ANSWERED by the owner (2026-07-03, same day):** wash-sale must
  not hard-block — it was settled with the modes work and needs no re-asking. The
  proceed route is the owner's route: defaults flip to the non-blocking modes
  (`washSaleHandling` → `auto`, `iraWashSaleHandling` → `disregard`); the block/ask
  options are de-emphasized (kept only for persisted-policy compatibility); the
  receipt/annotation machinery stays untouched — that is the "logs everything" half.
  Implementation on branch `claude/washsale-advisory-defaults`.
- Remaining sweep (notional caps and any other hard refusals): bring to the owner as
  plain-language questions — do NOT silently flip behavior without that conversation,
  and do NOT re-ask anything already answered above.
- UI copy standard: "deviations, receipted," never "rules bent"; keep the
  receipt/escalation machinery as the transparency substrate.
