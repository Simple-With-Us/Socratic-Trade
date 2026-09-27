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

### P0-2 — deterministic thesis-tag assignment, with the model's choice kept as a proposal

- `src/lib/strategy-prompts.ts` — `assignDeterministicThesisTag(evidence)` plus
  `shouldScoreThesisTagForSide(side)`, next to `THESIS_PLAYBOOK` (where the taxonomy already lives).
  Every tunable is env-overridable with a fail-safe fallback to the default.
- `src/lib/types.ts` — `TradeProposal.tradeThesisProposedTag?: string`, optional and additive.
- `src/lib/strategy.ts` — applied at the one seam (`rawBullProposals`) where the raw model answer, the
  scan evidence, and the run identity are all in scope. Fills `tradeThesisProposedTag` and overwrites
  `tradeThesisTag` only when the scorer actually assigns something different.
- Audit event `thesis_tag_assigned`, fired on **every scored proposal**, not only on override.

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

**The rule table.**  All six rules read only fields the market scan already computes.  The factor scale
is 0–100 with 50 = neutral (`scoreFactors`, `src/lib/market.ts`).

| tag | score | source field |
| --- | --- | --- |
| `Momentum-Breakout` | `momentum` | `factorBreakdown.momentum` — intraday move + 52-week position + technicals |
| `Value-Quality` | `max(value, quality)` | the two factors the playbook's own guide names for this tag |
| `Earnings-Catalyst` | `100 − days×(45/window)` | `daysToEarnings`, a source-provided countdown (window default 3) |
| `Insider-Accumulation` | `positioning` | `factorBreakdown.positioning` **and** insider evidence leading over congress |
| `Short-Squeeze-Risk` | `60 + min(20, short% − 20)` | `shortPercentOfFloat` (threshold 20 mirrors `positioningScore`) |
| `Sector-Relative-Strength` | `50 + min(30, rel×4)` | `sectorRelStrength`, a purpose-built cross-sectional field |

`Insider-Accumulation` needs the raw-field split because the `positioning` factor deliberately BLENDS
congress, insider and short interest into one number, so the factor alone cannot say which of the two
playbook tags it represents.

**Thresholds are not invented.**  `shortPercentOfFloat >= 20` and `insiderSentiment >= 60` are the
thresholds `positioningScore` already uses in `src/lib/market.ts`.  All six are env-overridable
(`THESIS_TAG_MARGIN`, `THESIS_TAG_NEUTRALFLOOR`, `THESIS_TAG_SECTORRELSTRENGTHPCT`,
`THESIS_TAG_SHORTFLOATPCT`, `THESIS_TAG_INSIDERSENTIMENT`, `THESIS_TAG_EARNINGSWINDOWDAYS`) so the
owner can calibrate against realized performance without shipping new constants; a malformed value
falls back to the default rather than poisoning the scorer.

**Abstention is the load-bearing part.**  The scorer returns `null` — and the MODEL'S TAG STANDS —
when no rule matches, when the best rule is below the neutral floor (55), or when the leader's margin
over the runner-up is under 8.  So the tail of the distribution is byte-identical to today, and the
residual set of underivable tags is explicit rather than papered over.

**How the divergence is made observable.**  Every scored proposal writes an audit event
`thesis_tag_assigned` carrying `proposedTag`, `assignedTag`, `overrode`, `rule`, `reason`, `runnerUp`,
`margin`, the full `scores` map, and `candidateFound`.  It fires on agreement too — "the scorer ran and
agreed" is what distinguishes a genuine agreement from a scorer that silently never ran.  With
`tradeThesisProposedTag` persisted alongside `tradeThesisTag`, the owner's existing performance report
can be recomputed on assigned tags and on proposed tags side by side.

**Why `candidateFound` is in the receipt.**  A proposal whose symbol is not in the scan's candidate set
scores on an empty evidence set and abstains.  Without that flag, "abstained because no candidate" and
"abstained because the evidence was genuinely ambiguous" would be indistinguishable in the data, and
the second is a signal worth chasing.

**Owner ruling requested** on three playbook tags that cannot be derived from existing evidence without
inventing semantics, and which the scorer therefore never emits:

- **`Mean-Reversion`** — needs "price is extended from its reference", which no computed field states.
  `technicalSignals` is a free-form `string[]` with an open-ended vocabulary, so substring-matching it
  would encode a guess as a rule.
- **`Defensive-Rotation`** — needs a definition of "defensive" (a sector list? a beta ceiling? a
  volatility regime?).  Nothing in the scan computes that classification.
- **`Analyst-Revision`** — we have `analystScore`, a consensus LEVEL.  A revision is a DELTA, and no
  field carries one.  Mapping a level onto "revision" redefines the tag.

Until that ruling, those three are assigned by the model and are the tags whose scorecards remain
model-graded.  A test asserts the scorer never returns them, so a future "completion" of the mapping
has to be a deliberate, reviewable change.

### P1-3 — the filings RAG path finally re-ranks on learned usefulness

- `src/lib/strategy.ts` — calls `applyRetrievalUsefulnessWeighting(chunks, userId)` on the filings
  chunks, placed after BOTH retrieval shapes (proposer dossier and plain `retrieveContextDetailed`)
  so neither can bypass it. Wrapped in its own try/catch that fails open to the retriever's order and
  warns, because an advisory nudge must never cost a dossier.
- `src/lib/retrieval-usefulness.ts` — the multiplier bound widened, and the header updated to name
  both callers.

**The bound was the actual bug, and this is worth stating plainly.**  `usefulnessMultiplier` computes
`1 + (hitRate − 0.5) * 0.4`, so its reachable range is **0.8–1.2** (±20%).  The old clamp of
0.9–1.1 was therefore **BINDING** — it was silently clipping a third off both ends of a signal that
was already computed.  Simply widening the clamp to 0.75–1.25 without noticing this would have
doubled the effective nudge as a side effect of a "constant tweak", which is exactly the kind of
unreviewed change that should not ship.  The fix keeps the coefficient as the operating range
(0.8–1.2, now reachable) and leaves 0.75/1.25 as a genuine backstop that binds only if the
coefficient is ever raised.  Net effect on the ranking: 2× the intended nudge, deliberately.

**No feedback loop — and the reason is structural, not care.**  The multiplier is keyed on the
AGGREGATE `doc_type|memoryKind` statistics, never on a per-document attribution.  A chunk can never
be credited for influencing a decision and then re-ranked on its own influence; a document's rank
moves because its whole TYPE has a track record.  There is no path by which a document's usefulness is
derived from the documents it itself influenced.  A test asserts the lookup key contains `doc_type`
and `memoryKindForDocType` and does NOT contain `vector_id` / `chunkId` / `chunk.id`, so a future
per-document re-rank fails loudly.

**An honest correction about "nudge, never takeover".**  Over a SHORT list the positional RRF base
gives a chunk at position 7 a threshold of only 0.896 to overtake position 0, so a ±20% nudge *can*
invert a wide gap.  The property the bound actually buys is: the multiplier is clamped regardless of
what the coefficient becomes, nothing is ever excluded, equal multipliers are rank-stable, and the
whole mechanism is toggleable and fail-open.  It is **not** "the retriever's order is preserved end to
end".  The test pins the real ratio (1.5) so a future coefficient change that turned the re-rank into
a takeover fails the assertion instead of passing silently.

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
| P0-2 deterministic thesis tag | **landed** (abstaining scorer + recorded proposal; 3 tags need an owner ruling) |
| P1-3 retrieval usefulness in the filings path | **landed** (with a corrected, honest statement of what the bound buys) |
| P1-4 retrieval stage telemetry read path | not started |
| P1-5 non-deep evidence depth | not started |
