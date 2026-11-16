# 2026-07-09 — Model recommendation rethink: per-team re-derivation of the rec chips (CLAUDE)

## Summary

Owner-directed re-derivation of the Green/Red model recommendation chips in the curated LLM
model catalog, implemented from a judged synthesis (three independent judges — reviewer-quality,
cost-ops, evidence-integrity — converged on the same four chips). Display-level only: no
behavior, defaults, or execution paths change.

New flags (both synced copies — `app/ui/llm-model-catalog.ts` + `app/console/settings/models.tsx`):

- **GREEN:** `claude-haiku-4-5` (new) + `gemini-3.5-flash` (kept)
- **RED:** `gemini-3.1-pro-preview` (new — owner ruling 2026-07-09, restoring the #1082/#1083
  intent) + `claude-sonnet-5` (new)
- **Removed:** `deepseek-v4-pro` Red; `gpt-5.4-mini` Green + Red; `gemini-3.5-flash` Red

Label change: `gpt-5.4-mini - balanced default` → `gpt-5.4-mini - balanced OpenAI mini` in both
copies. Verified before touching it: `DEFAULT_LLM_MODEL` (`app/ui/llm-model-catalog.ts:3`) had
ZERO imports anywhere in the repo — a dead export; nothing in the strategy path falls back to it
(`policy.llmModel`/`redTeamLlmModel` are consumed directly). The dead export was deleted in the
same pass. `app/console/assistant/models.tsx` was deliberately NOT touched — its picker has its
own live `DEFAULT_CHAT_MODEL = "gpt-5.4-mini"`, so "balanced default" remains literally true for
the assistant chat seat.

The conventions comment block atop `app/ui/llm-model-catalog.ts` was rewritten to the new
recommendation policy (substantive-output + realized-history + role-appropriate reasoning depth,
with owner rulings on top), documenting the two evidence traps the previous flags fell into
(degenerate-benchmark trap, incumbent-circularity trap) and the per-model evidence for every
current and removed chip. The console copy's comment now carries a condensed summary deferring to
the catalog block as canonical.

## Why (judged-synthesis rationale, verbatim)

> All three judges (reviewer-quality, cost-ops, evidence-integrity) independently landed on the
> same four chips, so this synthesis is a confirmation, not a compromise.
>
> Green — claude-haiku-4-5 + gemini-3.5-flash. Haiku is the benchmark's strongest honest signal:
> 3 real proposals every round with 89% stop-bracket population at 8.9s and $0.0067 a call —
> proposal volume and bracket compliance can't be gamed by emitting empty JSON, which is exactly
> how the old "winners" cheated the ranking. Gemini 3.5 Flash keeps its flag because it's the
> only model where fresh benchmark evidence and a clean live record (27 bull runs, 0 failures)
> agree; its cost is ~27s latency, which a proposer seat can afford. The pair spans two
> providers, and one of them is runnable today (haiku's Anthropic key is capped until 2026-08-01
> — an account setting, not a model quality, per your standing ruling).
>
> Red — gemini-3.1-pro-preview + claude-sonnet-5. Pro-preview is your ruling restored, and the
> evidence supports rather than contradicts it: it was 100% reliable and schema-valid, and token
> accounting shows it spent 300-600 thinking tokens before every verdict — categorically
> different from claude-haiku's Red seat, which emitted 33 flat tokens with zero thinking (that
> #1 Red rank was a ranking artifact and must not travel). Its all-veto rounds can't be graded
> because the benchmark captured no rejection reasoning — and the review pack itself (an odd
> 0.0005-share AAPL sell) may have deserved vetoing. Sonnet-5 is

_(Rationale excerpt ends here as provided by the synthesis; the remainder of the sonnet-5
justification — the only model besides claude-opus-4-8 with inspectable per-proposal review work
every round, 434-559 visible tokens, 7.1s, $0.0136, zero realized calls being the Anthropic key
cap and not a model quality — is captured in full in the catalog conventions block.)_

## Drops, in the synthesis's words

- **deepseek-v4-pro (Red)** — the one flag the benchmark actively contradicts: 0% Red schema
  validity with inconsistent invented keys (approvedProposals/survivingProposals) that the app's
  Bear parse (`parsed.proposals ?? []`) reads as a SILENT zero-survivor full veto, so its
  realized bear 17/3 likely counts no-ops as successes; its Green benchmark rows are confirmed
  8-token no-ops.
- **gpt-5.4-mini (Green)** — directly observed 1-in-3 reasoning-burnout failure (43.9s, 5500
  reasoning tokens, empty response), 24-50s latency on an OpenAI RPM=2 key, lowest proposal
  volume among substantive models; dominated by claude-haiku-4-5 on every forward axis; its 22/2
  realized record is real but incumbent-circular — it stays in the rotation pool and can earn
  the flag back on attributed data.
- **gpt-5.4-mini (Red)** — unverifiable all-veto reviewer (0 survivors x3 with all reasoning
  hidden); realized 18/1 is parse-level success counting under the same silent-veto inflation
  hazard; displaced by two verifiably better-evidenced seats.
- **gemini-3.5-flash (Red)** — crowding, not contradiction: 2/3 substantive rounds with one
  10-token collapse, and its 46/46 record is parse-level; loses the second seat to
  claude-sonnet-5's fully inspectable review work, and dropping it avoids two Gemini chips on
  the Red row (provider-concentration + same-provider Green/Red pairing risk). It keeps Green
  and is the sanctioned interim fallback if a seated Red is unavailable.

## Files

- `app/ui/llm-model-catalog.ts` — conventions comment block rewritten; flags per above; gpt-5.4-mini
  label; dead `DEFAULT_LLM_MODEL` export deleted.
- `app/console/settings/models.tsx` — synced flag + label changes; conventions comment condensed to
  defer to the catalog block.
- `docs/EFFORT-LOG.md`, `STATUS.md`, this note — protocol docs.

Not touched: `app/console/assistant/models.tsx` (live chat default, label not stale);
`app/console/strategy/page.tsx` and `app/console/components/model-stats-drawer.tsx` import
`CURATED_LLM_MODEL_GROUPS` and pick the new flags up automatically; `app/ui/model-picker.tsx`
(interface only, no flag data).

## Verification

- `git grep -n DEFAULT_LLM_MODEL` — only the definition existed (zero imports) before deletion;
  zero hits after.
- `npx tsc --noEmit` — clean.
- `npx vitest run test/model-rotation.test.ts` — 15/15 passed (the only test file importing the
  catalog; no test asserts rec flags).
- Full gate (lint / tsc / test / build) via `bash scripts/land.sh` at landing.

## Follow-ups

- **Harden the Bear parse** (`parsed.proposals ?? []`) to treat unknown envelopes as PARSE
  FAILURE instead of a silent zero-survivor "success" — precondition for ever seating a DeepSeek
  model as Red, and the fix that stops realized bear records from counting no-ops as successes.
- Next benchmark run must persist response bodies (or a rejection-reasoning field) so
  veto-vs-no-op becomes decidable.
- Re-adjudicate every chip as rotation mode (`ROTATE_ALL_MODELS_ID`) accrues attributed
  comparative live history (proposedByModel/reviewedByModel + model_rotation_pick audits).
- PR #1083 closed as superseded by this change (owner-directed): the gemini-3.1-pro-preview Red
  rec it carried is restored here as part of the full re-derivation.

## Update 2026-07-10 — re-synced with `main` after PR #1295 went dirty

`main` advanced 16 commits past this branch's merge-base while the PR sat waiting for review
(broker-minimum bump, unified provider quota, learning-review fixes, filings warm-up ingestion,
green/red label coloring in `models.tsx`, etc.), and GitHub flagged PR #1295 dirty. Merged
`origin/main` into `claude/model-recs-rethink` (`git merge-tree` dry run first — zero conflicts;
the real merge auto-resolved cleanly too).

Conflict-boundary check: `main` did **not** touch `app/ui/llm-model-catalog.ts` at all since the
merge-base, so the full rec-flag rewrite (and the conventions comment) landed untouched. `main`
did touch `app/console/settings/models.tsx`, but in a disjoint region — PR #1333 (`claude/green-
red-labels`) recolored the Proposer/Reviewer field labels and added the `bothRotate` sentinel
hint further down the file; this branch's changes are confined to the `MODEL_GROUPS` array and
its conventions comment near the top. No semantic collision: the label/rotation-hint work reads
`recommendedGreen`/`recommendedRed` only indirectly (via the unrelated same-model/same-provider
independence hint), so the merged file carries both sides' work as-is — verified by re-reading
the merged file directly, not just trusting the absence of `<<<<<<<` markers.

Verification after the merge: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit` clean;
`better-sqlite3` needed `npm rebuild better-sqlite3` under Node 24 first (this worktree's
`node_modules` had been built against the homebrew-default Node 26, NODE_MODULE_VERSION
mismatch 147 vs 137); after the rebuild, `test/model-rotation.test.ts`,
`test/console-red-team-labels.test.ts`, `test/model-stats.test.ts`,
`test/account-scoped-models-migration.test.ts`, and `test/approvals-triage-model.test.ts` all
pass (47/47). Pushed; PR #1295 mergeable again with auto-merge still armed for the required
`verify` CI gate.
