# Outcome closure: stop the system from grading its own homework (P0-1, P0-2)

Branch `minimax/outcome-closure` (worktree `~/apps/st-mm-outcome-closure`, based on `origin/main` @ `d0440ed22`).
Seat: MINIMAX.  Started 2026-09-27.

## 1. Context & Objective

A four-part audit of Socratic.Trade's learning loop produced two P0 findings that together mean the
system cannot currently learn from its own outcomes.  **P0-1**: the highest-quality artifact the app
produces — a post-mortem lesson about a trade it already closed and measured — is graded by an LLM
risk gate, upgraded to `risk`, and parked in a human approval queue, so it never reaches the brain it
is read from.  **P0-2**: `tradeThesisTag` is chosen by the same model that then gets graded on it, so
the model can relabel its way out of a size penalty or an expectancy skip, and every "P&L by thesis"
figure has a label and an outcome that are not independent.

This rollout covers the fixes for those two, plus three P1 items (retrieval usefulness never
re-ranked, retrieval telemetry with no read path, evidence depth that reinforces the ranking instead
of testing it).  Per-section status is recorded in §7.

## 2. Changes Made

### P0-1 — autonomous post-mortem lessons bypass the LLM semantic-gate layer

The route a lesson took before: `outcome-engine.ts` writes it as an ordinary `kind: "decision"`
candidate → `ingestLearned` → `classifyWithSemanticGate` → the keyword layer returns `fact` → the LLM
gate is asked whether the text "would influence position sizing, exposure, leverage, stops, risk
tolerance, concentration, or **trading behavior**" → a lesson like *"size down after failed breakouts"*
answers yes by construction → upgraded to `risk` → inserted into `learned_context_pending`, which is
read only by a human approval click or the nightly Learning Review.

The fix is an explicit, opt-in, per-candidate provenance marker, not a behavioural guess.

- `src/lib/types.ts` — new `LearnedContextCandidateProvenance = "system-postmortem"` and an optional
  `provenance` field on `LearnedContextCandidate`.  Deliberately **not** inferred from `origin`.
- `src/lib/learned-context/semantic-gate.ts` — new step **1b**, placed after the keyword layer and
  before the allowlist/LLM call.  A stamped candidate returns the keyword tier without consulting the
  LLM.
- `src/lib/learned-context/store.ts` — `provenance` is threaded into the `learned_context.write` audit
  payload, so a row that reached the brain *because* the gate was skipped is distinguishable after the
  fact without a schema migration.
- `src/lib/outcome-engine.ts` — the lesson producer stamps `provenance: "system-postmortem"` and
  changes `source` from the generic `"inferred"` to `"postmortem-outcome"`, so a lesson written here is
  identifiable in the brain's own provenance line (`source=postmortem-outcome`).

What the bypass deliberately does **not** do, each pinned by a test:

- It does not bypass the keyword layer.  Step 1 runs first, so a lesson naming a real risk knob
  (`"raise max position size after the loss"`) is still `risk` and still queued for human approval.
  Only the LLM *upgrade* is skipped, never the risk layer itself.
- It does not touch the PII gate, which runs before classification in the store.
- It does not weaken the gate for anything else.  `origin: "autonomous"` alone does not bypass it —
  several unrelated producers use that origin (chat-coach ingest, research transfer), so keying off it
  would silently disable the gate for text the app did not derive from its own outcomes.
- It cannot change numeric policy.  A `learned_context` row is advisory prompt DATA;
  `classify.ts` already documents the semantic-channel residual (a fact can prime the model's
  conviction, which feeds size) and this change does not widen that class beyond the app's own
  measured post-mortem text.

Side effect, positive: this is the only ingest path that no longer spends an LLM call per lesson.

### P0-2 — deterministic thesis-tag assignment — NOT YET IMPLEMENTED IN THIS COMMIT

Design work is done and recorded in §3; the code lands in the next commit on this branch.

## 3. Deterministic tag-assignment rule (P0-2)

The thesis playbook has ten tags.  The scanner already computes a deterministic evidence digest per
candidate — `factorBreakdown` (eight weighted 0–100 factors plus `weightedTotal`), `technicalScore` /
`technicalDirection` / `technicalSignals`, `sectorRelStrength`, `daysToEarnings`, `insiderSentiment` /
`insiderTradesQuiver` / `senateTrades` / `congressComposite*`, `shortPercentOfFloat` / `putCallRatio`,
`analystRating` / `analystScore`, and the valuation/quality fields.  The scorer reads only those.

**Assigned when a rule fires; the LLM's choice is kept and recorded as a proposal; when no rule fires the
scorer ABSTAINS and the LLM's tag stands.**  Abstention is the important design decision: it means the
change is strictly additive at the tail, no tag is ever lost, and the residual set of un-derivable tags
is explicit rather than papered over with a plausible-looking guess.

> **Status: not implemented in this commit.**  The rule table, margins, tunables, and the list of tags
that need an owner ruling are filled in as the code lands.

## 4. Decisions & Trade-offs

- **Provenance marker, not a behaviour heuristic.**  The alternative — loosening the gate prompt, or
  special-casing the `decision_lesson:` subject prefix — would have silently changed behaviour for any
  future producer that reused the prefix.  A one-value union that each future producer must opt into
  is reviewable.
- **Ablation: skipped.**  Making more advisory facts reach the prompt does touch the documented
  semantic channel.  It was not gated behind a flag because the whole point is that the lessons must be
  readable; instead the change is bounded to text the app derived from its own closed trades, and the
  keyword risk layer still gates anything that reads like a policy instruction.
- **Learning Review auto-approval was NOT implemented.**  The briefing offered it as an option.  With
  the LLM upgrade gone, the lessons that were stuck in pending are the ones the *keyword* layer
  flagged, which are precisely the ones that name a risk knob — auto-approving those would remove a
  human gate on exactly the rows where it matters most.  The stated problem is solved at the routing
  layer instead.  Recommend against it.
- **`post-mortem.ts` is a related finding, out of scope here.**  `writeTrackRecordFacts`
  (`src/lib/post-mortem.ts:530`) writes the thesis track-record facts the same way, and its value
  string embeds a lot count ("23 lots"), which `NUMERIC_RISK_PATTERN` matches — so those facts are
  forced to `risk` by the **keyword** layer and queued.  A provenance marker cannot help, because the
  keyword layer is authoritative and must stay so.  Logged as a follow-up rather than fixed, because
  `post-mortem.ts` is owned by another lane.

## 5. Verification State

- `npx tsc --noEmit` — clean, exit 0.
- `npx vitest run test/semantic-gate.test.ts test/outcome-engine.test.ts` — 2 files, **44 passed**.
- `npx vitest run test/learned-context.test.ts test/learned-context-pending.test.ts
  test/learned-context-account-scope.test.ts test/learning-review.test.ts test/post-mortem.test.ts` —
  5 files, **103 passed**.
- Full gate (`npm run lint`, `npm test`, `npm run build`) and the remaining P0-2 / P1 items are
  recorded as they land; see §7.

## 6. Next Steps & Blockers

- Land P0-2 (deterministic thesis tag) as the next commit on this branch.
- P1-3 / P1-4 / P1-5 after that, in that order.
- Owner ruling requested on the thesis-tag taxonomy for the tags that cannot be derived from
  already-computed evidence (see §3).
- `src/lib/post-mortem.ts` track-record facts are a related finding owned by another lane; see §4.

## 7. Item status

| Item | Status |
| --- | --- |
| P0-1 autonomous-provenance gate bypass | **landed** (this commit) |
| P0-2 deterministic thesis tag | design done in §3; code pending |
| P1-3 retrieval usefulness in the filings path | not started |
| P1-4 retrieval stage telemetry read path | not started |
| P1-5 non-deep evidence depth | not started |
