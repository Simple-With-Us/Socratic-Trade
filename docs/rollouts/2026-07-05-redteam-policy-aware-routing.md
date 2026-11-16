# 2026-07-05 - redteam-policy-aware-routing

## Summary

Closes the last remaining fail-open path in the approval-time Red Team debate
(`debateProposal`, `src/lib/red-team.ts`) and makes the debate's failure handling
policy-aware and consistent with the in-flow Bear's existing behavior:

- **Deliverable A — kill the shape-coercion fail-open.** Both the OpenAI-compatible path
  and the legacy `debateViaAnthropic` cross-provider path did `rejected: !!parsed.rejected`
  after a successful `JSON.parse`, which silently coerced a parseable-but-schema-violating
  response (missing/non-boolean `rejected`) into an **approved, available:true** verdict.
  Both paths now validate the parsed shape (`typeof parsed.rejected === "boolean"`) and fail
  closed (`available:false`, `rejected:false`, `failureKind:"malformed_response"`) on any
  shape violation, preserving the pinned T11 return contract.
- **Deliverable B — structured failure kind ("RED TEAM FAILED" flag, part 1).**
  `RedTeamDebateResult` and `TradeProposal.redTeamVerdict` gained an optional
  `failureKind?: "not_configured" | "timeout" | "provider_error" | "rate_limited" |
  "malformed_response"`, populated at every failure site in both provider paths (no key,
  non-2xx incl. 429, abort/timeout vs other thrown errors, and the two JSON-shape failure
  modes). A new `audit("strategy_red_team_unavailable", {symbol, side, reason,
  failureKind, heldForHuman}, userId)` gives the standalone debate the same audit parity the
  in-flow Bear already had (`strategy_bear_review_unavailable`).
- **Deliverable C — de-risk-only routing consistency, gated behind a default-OFF policy
  flag.** Previously the standalone debate's unavailable branch routed to
  `requiresHumanReview` regardless of side, so a risk-reducing `sell`/`cover` could get
  frozen behind human approval exactly when de-risking mattered most — inconsistent with
  the in-flow Bear, which already exempted exits. Extracted a pure helper,
  `routeOnAdversaryUnavailable(side, failureKind, reason, deRiskExitsOnAdversaryUnavailable?)`
  in the new `src/lib/red-team-routing.ts`. Openings (`buy`/`short`) ALWAYS hold for human
  review, unconditionally. Exits (`sell`/`cover`) also hold for human review **by default**
  — letting an exit proceed straight to autonomous placement is a real behavior change (a
  sell/cover that today gets frozen for human sign-off on an adversary outage would
  otherwise auto-execute with real capital instead), so per COMMON.md hard rule 4 this ships
  behind a new, default-OFF `policy.tuning.deRiskExitsOnAdversaryUnavailable` flag. Only
  when an operator explicitly sets it to `true` do exits proceed with a loud rationale note
  instead of being held. **Default false: default behavior is byte-identical** — with the
  flag unset (or `false`), every proposal (buy/short/sell/cover) is still added to
  `requiresHumanReview` when the Red Team debate is unavailable, exactly matching
  `origin/main`'s unconditional hold.
- **Deliverable D — loud human-facing flag ("RED TEAM FAILED", part 2).** The `decide`-
  authority pending-approval card's persisted reason now includes the failureKind (e.g.
  `"Red Team review unavailable (rate limited); routed to human approval."`) instead of a
  generic message; the card's title is unchanged (nothing pins it, but kept stable per the
  spec's own caution). Under `propose` authority, every proposal already becomes a pending
  card unconditionally — previously a Red-Team-unavailable signal was invisible on that
  card. The propose-mode branch now appends the same loud `"⚠ RED TEAM FAILED (<kind>):
  review unavailable — awaiting human approval."` note when the proposal is also flagged in
  `requiresHumanReview`, so the approving human sees the adversary never ran.

## Why

Board item: "Bear/Red-Team unavailable → policy-aware routing for ALL failure modes
(propose→human-approval; autonomous→de-risk-only + 'RED TEAM FAILED' flag) across
timeout/429/malformed-JSON, replacing the remaining fail-open paths." The mode-aware core
(fail-closed via `requiresHumanReview` under `decide`; unconditional pending-card under
`propose`) already existed pre-this-change. What remained was: (1) the one concrete,
still-live fail-open bug (`!!parsed.rejected` coercion), (2) no structured failure
classification for downstream routing/observability, (3) an inconsistency where a
risk-reducing exit could get needlessly frozen on an adversary outage, and (4) the failure
signal being invisible or under-detailed on the human-facing card. This closes all four
without touching PR #814's advisory-override machinery, `isHardGateReason`, or any
`BLOCKING` gate.

Deliverables A, B, and D are a stricter fail-closed classification or an advisory rationale
note only, per house convention (receipts, not cages) — no default-behavior change, no flag
needed. Deliverable C is different in kind: removing the previously-mandatory human-approval
hold on a de-risking exit is a control relaxation on the autonomous execution path, not just
a rationale note (a sell/cover that used to require sign-off before touching real capital
would otherwise auto-place). Per COMMON.md hard rule 4 that ships behind a new,
default-OFF `policy.tuning.deRiskExitsOnAdversaryUnavailable` flag — see Deliverable C above.

## Files

- `src/lib/red-team.ts` — `RedTeamDebateResult.failureKind` (new optional field);
  `isAbortTimeoutError` and `validateRedTeamVerdictShape` helpers; shape-validation fix in
  both the OpenAI-compatible path (`debateProposal`) and the legacy Anthropic path
  (`debateViaAnthropic`); failureKind populated at every failure site in both paths; explicit
  `Promise<{...}>` return-type annotations on the two `withLlmGeneration` callbacks (needed
  so TS keeps the `failureKind` literal union narrow instead of widening to `string` across
  the callback's multiple `return` sites).
- `src/lib/red-team-routing.ts` — **new file.** Pure helpers: `describeRedTeamFailureKind`
  (human-readable label) and
  `routeOnAdversaryUnavailable(side, failureKind, reason, deRiskExitsOnAdversaryUnavailable?)`
  (the policy-gated de-risk-only routing decision + loud rationale note), used by both the
  human-review-hold branch and the propose-mode branch in `strategy.ts`. Openings always
  hold; exits hold too unless the 4th arg is `true`.
- `src/lib/strategy.ts` — `redTeamVerdict` stamping now includes `failureKind` when present;
  the `!redTeamResult.available` branch now calls `routeOnAdversaryUnavailable` (passing
  `policy.tuning?.deRiskExitsOnAdversaryUnavailable`) instead of unconditionally adding to
  `requiresHumanReview`, and emits the new `strategy_red_team_unavailable` audit; the
  `decide`-authority pending-card branch's persisted reason now includes the failureKind;
  the `propose`-authority branch appends the loud note when the proposal is in
  `requiresHumanReview` and its verdict is unavailable.
- `src/lib/types.ts` — `TradeProposal.redTeamVerdict.failureKind` (new optional field,
  mirrors `RedTeamDebateResult.failureKind`); `TuningSettings.deRiskExitsOnAdversaryUnavailable?:
  boolean` (new, default-OFF policy flag gating Deliverable C, with a "Default false: default
  behavior is byte-identical" doc comment per COMMON.md hard rule 4).
- `test/red-team.test.ts` — extended with 9 new tests: shape-violation fail-closed for 3
  malformed payload shapes, 429→`rate_limited`, 500→`provider_error`, AbortError→`timeout`,
  generic thrown error→`provider_error` (not timeout), no-key→`not_configured`, and a valid
  verdict has `failureKind: undefined`. The 4 pre-existing tests are unmodified and still
  pass (T11 contract intact).
- `test/redteam-failure-routing.test.ts` — **new file.** Pure unit tests for
  `routeOnAdversaryUnavailable`/`describeRedTeamFailureKind` covering both the default
  (flag unset/`false`: openings AND exits hold, byte-identical to main) and opt-in
  (`deRiskExitsOnAdversaryUnavailable: true`: exits proceed with the loud note) paths, all
  failureKind labels, and the undefined-failureKind fallback. Plus four `runStrategyOnce`
  end-to-end tests (mirroring `test/strategy-money-path-f-g.test.ts`'s pattern): (1) a
  high-conviction opening is held for human review with the failureKind visible in both the
  persisted `redTeamVerdict` and the rationale, and the `strategy_red_team_unavailable`
  audit fires with `heldForHuman: true`; (2) **default policy** (flag unset): a
  high-conviction sell of an existing (seeded) position is STILL held for human review
  (`heldForHuman: true`), proving default behavior is unchanged; (3) **opt-in policy**
  (`deRiskExitsOnAdversaryUnavailable: true`): the same sell is NOT held — it places, with a
  "RED TEAM FAILED... reduces risk" rationale note and `heldForHuman: false` in the audit;
  (4) under `propose` authority (default policy) the pending card's rationale carries the
  "RED TEAM FAILED" note.

## Verification

Re-run after the redteam fixer pass added the `policy.tuning.deRiskExitsOnAdversaryUnavailable`
gate (see "Post-review fix" below):

- `npx tsc --noEmit` — clean, no output.
- `npx vitest run test/redteam-failure-routing.test.ts test/red-team.test.ts` — **2 files /
  26 tests, all passed** (1.33s).
- `npm test -- --run` (full suite) — **261 files / 2599 tests, all passed** (18.13s).
- `npm run lint` — **0 errors, 310 warnings** (pre-existing grandfathered
  `@typescript-eslint/no-explicit-any`/`no-unused-vars` warnings, same baseline as before
  this pass). No new lint findings in the touched files
  (`src/lib/red-team-routing.ts`, `src/lib/strategy.ts`, `src/lib/types.ts`,
  `test/redteam-failure-routing.test.ts`).
- `npm run build` intentionally NOT run (orchestrator runs it at landing, per COMMON.md).

## Post-review fix: default-OFF gate added for Deliverable C

An adversarial review correctly flagged that the original version of this change violated
COMMON.md hard rule 4: `routeOnAdversaryUnavailable` unconditionally exempted `sell`/`cover`
proposals from `requiresHumanReview` for every policy/user, with no flag. On `origin/main`,
ALL sides (including sell/cover) are held for human approval when the Red Team debate is
unavailable; this diff removed that hold for exits unconditionally, which is a control
relaxation on the autonomous real-money execution path (a de-risking sell could go straight
to placement without human sign-off the moment the adversary hiccuped — timeout, 429,
malformed JSON, or no key), not merely an advisory rationale note. The lane's own new test
(`test/redteam-failure-routing.test.ts`, exit-not-held case) documented this exact behavior
change, and the original wording of this doc's "Why" section only defended the framing
("closes an inconsistency... without touching any BLOCKING gate") without acknowledging that
removing a mandatory human hold is itself a behavior/control change requiring a flag.

Fix applied: `routeOnAdversaryUnavailable` now takes a 4th parameter,
`deRiskExitsOnAdversaryUnavailable?: boolean`, sourced from the new
`policy.tuning.deRiskExitsOnAdversaryUnavailable` (default `undefined`/`false`). With the
flag off (the default for every existing policy), exits hold for human review exactly like
openings — byte-identical to `origin/main`'s unconditional
`requiresHumanReview.add(proposal)`. Only with the flag explicitly set `true` does the
de-risk-only routing (no hold, loud "RED TEAM FAILED" note) take effect. Tests were updated
to assert both the default (still-held) and opt-in (de-risk-only) paths; no other lane
deliverable (A, B, D) needed changes, since none of those relax an existing block/hold.

## Design decisions

- **Side classification stays raw-side** (`buy`/`short` = opening, `sell`/`cover` = exit),
  matching the codebase-wide convention and the in-flow Bear's own exit exemption.
  Net-exposure-aware classification (a buy that actually covers an existing short) is an
  explicitly deferred follow-up per the lane spec — not implemented here.
- **`failureKind` is optional and additive everywhere** — a missing/legacy verdict (no
  `failureKind`) degrades to a generic "unavailable" label via `describeRedTeamFailureKind`,
  so nothing that reads an older persisted `redTeamVerdict` breaks.
- **No new `SocraticEvidenceItem.kind`** was added; the new audit event and rationale notes
  are the receipt channel, per COMMON.md rule 5.
- **The debate's own function-return contract is unchanged for the success path** — a valid
  `{rejected, reason}` verdict still returns exactly `{rejected, available, reason, model}`
  with `failureKind` absent (verified with `toEqual` in the existing pinned tests, which do
  exact-object-equality and would fail if `failureKind` leaked in on the happy path).
- **Explicit `Promise<{...}>` return-type annotations were added to both `withLlmGeneration`
  callbacks** in `red-team.ts`. Without them, TypeScript widened the inferred `failureKind`
  literal union to `string` across the callback's several `return` statements (a
  quirk of inferring a generic `T` from a multi-branch async arrow function), which tripped
  `tsc --noEmit`. This is a type-level-only change with no runtime effect.
- **The 429→`rate_limited` vs other non-2xx→`provider_error` split is based on
  `response.status`, not on parsing the error body** — simplest and most reliable signal
  available at both call sites.
- **`isAbortTimeoutError` checks `error.name` (`AbortError`/`TimeoutError`) or a
  message regex fallback** (`/abort|timed?\s*out/i`) rather than only `instanceof
  DOMException`, since `AbortSignal.timeout()`'s thrown error shape can vary slightly
  across the Node/undici versions this repo may run on; this is intentionally lenient so a
  genuine timeout is still classified `timeout` rather than falling through to the more
  generic `provider_error`.

## Deviations from spec

- None of substance. The spec's suggested "preferred: pure helper" path for the routing
  test was taken exactly as suggested (`routeOnAdversaryUnavailable` in a new
  `src/lib/red-team-routing.ts`, unit-tested directly, called from both branches) rather
  than driving everything through `runStrategyOnce`; the E2E tests were added anyway (3 of
  them) to close the loop end-to-end per the spec's test item 4, using the existing
  `test/strategy-money-path-f-g.test.ts` fetch-stub/seed pattern as a base.
- The spec's exact wording for the exit-side note (`"⚠ RED TEAM FAILED (<failureKind>):
  review unavailable — proceeding because this order reduces risk."`) is reproduced
  verbatim in `routeOnAdversaryUnavailable`, with `<failureKind>` rendered through
  `describeRedTeamFailureKind` (e.g. "rate limited" instead of the raw enum
  `rate_limited`) for human readability — a minor, intentional formatting choice, not a
  content deviation.
- **Added beyond the spec's literal text (required by COMMON.md, not by lane1-redteam.md):**
  the lane spec's Deliverable C description does not itself mention a policy flag. COMMON.md
  hard rule 4 is a repo-wide, non-negotiable constraint that supersedes lane-spec silence —
  any behavior change ships behind a default-OFF `policy.tuning.*` flag. A post-review pass
  added `policy.tuning.deRiskExitsOnAdversaryUnavailable` (default false) gating the
  exit-side de-risk-only routing; see "Post-review fix" above. This is additive only — the
  lane spec's described end-state (exits proceed with a loud note) is still fully
  implemented and reachable, just opt-in rather than unconditional.

## Out of scope (explicitly deferred, not implemented — matches lane spec)

- Retry/failover before declaring the debate unavailable (design doc §4.3).
- Single-adversary consolidation — the in-flow Bear and the standalone `debateProposal`
  remain two separate passes (design doc §3.1).
- Three-way verdict (`approve`/`approve-at-half`/`reject`) (design doc §3.3).
- Net-exposure-aware side classification — a buy that nets risk-reducing (covers an
  existing short) is still treated as risk-increasing by raw-side rules (design doc §3.5).
- `resolveRoleModel`'s same-family soft-fallback when no cross-family credential exists
  (`src/lib/llm-provider.ts`) — unchanged.
- Deprecating `debateViaAnthropic` / the legacy `RED_TEAM_LLM_PROVIDER` env-var path — both
  still exist, now with the same shape-validation and failureKind fixes as the primary path,
  but not consolidated.
- No changes to PR #814's veto/override semantics (`preVetoReasons`, `redTeamVerdict.overridden`,
  `isHardGateReason`'s prefix short-circuit) — confirmed all touched tests
  (`test/hard-gate-classification.test.ts`, `test/pre-veto-override.test.ts`) still pass
  unmodified.
- No change to what happens to a REJECTED-and-available (not unavailable) exit — an
  available debate that explicitly rejects a sell/cover is still dropped via `continue`,
  exactly as before; this change only touches the `!available` (unavailable/failed) branch.

## Follow-ups

- Consider consolidating `debateViaAnthropic`'s failure/shape handling fully with the
  primary `resolveLlmEndpoint`-driven path (they now share the same `failureKind` taxonomy
  and `validateRedTeamVerdictShape` helper, but remain textually duplicated across two
  functions in `red-team.ts`) — likely a natural side-effect of the not-yet-implemented
  single-adversary consolidation (design doc §3.1).
  - Note logged in-thread for `#ag***-s**c`, no separate task filed.
- Net-exposure-aware side classification (a buy that covers an existing short is actually
  risk-reducing, not risk-increasing) would sharpen `routeOnAdversaryUnavailable` further —
  deferred per the lane spec's explicit "do NOT implement" list.
- The card title `"${symbol} awaiting approval (Red Team unavailable)"` was kept stable per
  the spec's caution; if a future UI change wants the failureKind in the title itself
  (rather than just the persisted `reasons[0]` string), that's a small, isolated follow-up.
