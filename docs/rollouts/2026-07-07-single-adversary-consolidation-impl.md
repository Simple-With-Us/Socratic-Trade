# 2026-07-07 — Single-adversary consolidation: drift found + owner-revised, implementation started

> **2026-07-07 (later, MONET): COMPLETE.** All remaining stages (1b–5) implemented on branch
> `monet/single-adversary-consolidation` (built ON the Stage-1a work below, reconciled onto current
> `origin/main` — supersedes preservation draft PR #1035). Full record appended at the bottom of
> this note ("MONET completion record"). The staged NEXT list below is now historical.

## Summary
- **Discovery:** `docs/single-adversary-consolidation.md` (all §9 decisions RESOLVED
  2026-07-01, Codex-reviewed) was **never implemented**. Verified: both adversarial
  passes still run — the in-flow Bear inside `proposeTrades` (`src/lib/strategy.ts`
  ~`4406`, `step:"bear"`) AND the escalated `debateProposal` (`src/lib/red-team.ts:81`,
  called `src/lib/strategy.ts:1282`, gated by `shouldRunRedTeamDebate` `:2206`). Code
  cross-check: `grep -rn "approve-at-half\|adversaryUnavailable\|extractJsonPayload\|fetchLlmWithRetry" src` → nothing.
- **New binding rule** added to `AGENTS.md` ("Design-vs-implementation drift — FLAG
  IT") + announced in `#ag***-s**c`: every agent must verify design docs against code,
  flag decided-but-unimplemented work to the owner, stamp the doc, keep an EFFORT-LOG row.
- **Owner revision (2026-07-07)** of the spec's independence model (banner added to the
  spec top). New rules govern and override §3.8/§8/O4/R12–R14:
  - No model default for anything, ever (delete Green default, red→green fallback,
    cross-family default map, env default).
  - Green + Red models both mandatory + explicitly chosen; impossible to run without
    both (enforce at policy-save + Settings UI; fail-closed at runtime as backstop).
  - Only providers the user holds a key for are selectable in Settings.
  - Same model for both allowed if chosen; drop hard same-model prohibition + write-time
    independence enforcement; independence is a non-blocking Settings hint, never a gate.
  - Unchanged: one adversarial call doing both jobs, kill `RED_TEAM_LLM_PROVIDER` env
    override, exits never reviewed, all-openings coverage, never-silent failure, §4
    reliability + §5–§7 visibility/persistence (R1–R20).

## Audit — other specced-but-unimplemented / deferred work found (2026-07-07)
- **Confirmed silent miss:** single-adversary consolidation (this effort).
- **Historical miss (since fixed):** PR #161 multi-provider chat "never landed" —
  `docs/rollouts/2026-06-25-chat-multi-provider-models.md:11`.
- **Honestly-labeled DEFERRED (tracked, not silently dropped)** in
  `docs/phase-7-strategy.md`: House congressional coverage (needs free feed),
  Šidák/Bonferroni multiple-testing correction, P1-5 calibration; and
  `docs/rollouts/2026-06-20-money-path-merge-gate.md:39` "Follow-ups (user-approved,
  not yet implemented)". These are acknowledged, not thought-shipped.
- A full forensic pass over the 1471-line EFFORT-LOG + git history was not done; the
  above is the clearly-identifiable set from status markers + code cross-checks.

## Implementation plan (staged, current-code-grounded — spec anchors have drifted; UI moved to app/console)
1. **Model rules (foundation):** `src/lib/llm-provider.ts` (`resolveRoleModel`,
   remove Green/red defaults) + `src/lib/llm-request.ts` (`resolveOpenAiModel`) →
   no defaults; typed "unconfigured" result. `app/api/policy/route.ts` validation +
   `app/console/settings/models.tsx` → both required, keyed-providers-only dropdown,
   same-model allowed.
2. **One adversary:** delete in-flow Bear LLM in `proposeTrades` (keep
   `deterministicBearFilter`); rewrite `debateProposal` (`src/lib/red-team.ts`) as the
   single reviewer told to do both jobs (fact-check candidate evidence + finalized-size
   critique); remove the second call site's duplication; kill `redTeamProvider()` /
   `RED_TEAM_LLM_PROVIDER`.
3. **Reliability (R9/R10/R1–R4):** `extractJsonPayload` in `src/lib/llm-call.ts`
   applied at all parse sites; `fetchLlmWithRetry`; three-verdict + `approve-at-half`
   placeability re-check; bounded concurrency.
4. **Visibility/persistence (R8/R18/R19, §5–§7):** persist `adversaryUnavailable` +
   reason on the proposal `decision`; amber badge in `app/console/components/approval-card.tsx`;
   notification payload flag; record Red-Team rejections as rows.
5. **Tests + verify gate + handoff docs.**

## Status
- DONE: audit, AGENTS.md rule + Slack announce, spec-doc stamp + owner-revision banner,
  this rollout note.
- DONE — **Stage 1a: resolution layer → no defaults** (owner's core rule). `resolveOpenAiModel`
  returns "" (not `OPENAI_MODEL` env / `DEFAULT_OPENAI_MODEL`) when Green unset; `resolveRoleModel`
  returns "" for an unset Red (no green fallback, no cross-family default); removed
  `CROSS_FAMILY_RED_TEAM_DEFAULT` + `defaultCrossFamilyRedTeamModel` + the userId param. Tests
  rewritten to the new contract. Added shared `extractJsonPayload` (R9) + tests.
- DONE — **chat de-default**: removed the hardcoded chat model defaults (`DEFAULT_OPENAI_MODEL` and
  `"claude-opus-4-8"`) from `app/api/chat/route.ts` (`llmFromProvider`) and `src/lib/chat/llm.ts`
  (`getLLM`); the chat model must now be an explicit per-request model or `CHAT_LLM_MODEL`, else
  MockLLM. Deleted `DEFAULT_OPENAI_MODEL` entirely (zero users).
- DONE — **policy-save validation** (`app/api/policy/route.ts`): stopped silently deleting a blank
  Red model (no more implicit fallback); added server-side keyed-provider backstop — a chosen
  Green/Red model must belong to a provider the user holds a key for; same-model allowed.
- NEXT (this effort, staged): **1b-remaining** — runtime fail-closed backstop in `strategy.ts` when a
  resolved model is "" (skip/route-to-human with a clear reason) + `app/console/settings/models.tsx`
  (both mandatory, keyed-providers-only *selectable*, same-model allowed, drop the "same as Green"
  empty option). **2** one adversary (delete in-flow Bear LLM in `proposeTrades`, rewrite
  `debateProposal` to do both jobs, kill `RED_TEAM_LLM_PROVIDER`). **3–4** reliability/visibility
  (R1–R20). **5** tests + verify + handoff docs.
- VERIFY-ITEMS for the landing lane: (1) `usage-budget.ts:376` tolerates greenModel==="". (2) The
  keyed-provider policy check requires `resolveLlmCredential`/`llmModelFamily` — confirm no import
  cycle (`app/api/policy` → `@/lib/llm-provider` → `@/lib/db`). (3) Existing tests/fixtures that PUT a
  policy with a model but no matching key will now 400 — update fixtures.
- Delivery: edited in the mounted `main` worktree (Cowork session can't reach the
  `agent/claude` lane or pull; base is 12 commits behind `origin/main`). **Cowork sandbox can't run
  the verify gate** (linux-arm64 vs macOS-compiled `better-sqlite3`/`vitest`/rolldown bindings), so
  a gate-capable lane must run `tsc`/`lint`/`test`/`build` + `land.sh` + PR. VERIFY-ITEM for the
  lane: `usage-budget.ts:376` (`resolveOpenAiModel` → greenModel) now tolerates "" — confirm no
  throw. The CHAT assistant default (`DEFAULT_OPENAI_MODEL` in chat/llm.ts + app/api/chat) is
  intentionally left in this pass — flag to owner if he wants chat de-defaulted too.

## Files touched this session
Docs/tracking: `AGENTS.md` (drift rule), `docs/single-adversary-consolidation.md` (status +
owner-revision banners), `docs/EFFORT-LOG.md` (rows), this note, `IMPROVEMENTS-2026-07-07.md`
(finding #4 corrected).
Code (Stage 1a + R9): `src/lib/llm-request.ts` (resolveOpenAiModel no default; DEFAULT_OPENAI_MODEL
scoped to chat), `src/lib/llm-provider.ts` (resolveRoleModel no defaults; removed cross-family
default + userId param), `src/lib/llm-call.ts` (+`extractJsonPayload`), `test/llm-request.test.ts`,
`test/llm-provider.test.ts`, `test/llm-call-json-payload.test.ts` (new).

## Follow-ups / risks
- STATUS.md + `docs/EFFORT-LOG.md` row + `PLAN.md` + `docs/phase-7-strategy.md:65`
  status flip are due at land (no commit made this session).
- Safety-critical (real-money trade gate): implement in compiling, verified stages;
  never leave a half-wired gate.

---

# MONET completion record (2026-07-07, stages 1b–5)

## Summary
Owner handed the effort to MONET end-to-end (see
`docs/rollouts/2026-07-07-single-adversary-consolidation-handoff-monet.md`). Reconciliation: the
Stage-1a edits had already been preserved by another Claude session as draft **PR #1035** (branch
`claude/single-adversary-consolidation-wip`, based `add1bd29`, 22 commits behind). Verified none of
the 22 drift commits touched the Stage-1a files (the "#1014 refactored the same llm layer" warning
was a false alarm — #1014 refactored the *congress* stream client), cherry-picked Stage 1a cleanly
onto current `origin/main` (`77ee87af`), then implemented everything that remained.

## What was built (by stage)

**Stage 1b — model rules finished**
- Runtime fail-closed: `proposeTrades` throws `LLM_MODEL_REQUIRED_STRATEGY_MESSAGE` when the Green
  model resolves to `""`; `app/api/strategy/run` pre-checks and 412s with the same message. A blank
  Red fails closed per-opening inside `debateProposal` (`not_configured`).
- **`DEFAULT_POLICY.llmModel` ("gpt-5.4-mini") REMOVED** — the seeded policy default would have
  resurrected the exact silent default the resolution layer deleted. Console display fallbacks
  (`DEFAULT_GREEN_MODEL_ID`, approval-card red→green fallback) removed with it.
- Settings (`app/console/settings/models.tsx`): both models REQUIRED (save blocked while either
  blank + warning banner), "app default"/"same as strategist" idioms gone, keyed-providers-only
  options (unchanged, now load-bearing), non-blocking independence hint (same model / same
  provider), reviewer-reliability hint copy (§6, tooltip-length).
- R16: `ops-snapshot` resolves Red via `role:"red"`; unconfigured Red reports null/false.
- `usage-budget`: Red never falls back to Green; blank Green → `NO_DECISION` (fails closed pre-spend).
- R15: db migration **v15** seeds blank per-account `redTeamLlmModel` ONCE from a live
  `RED_TEAM_LLM_PROVIDER=anthropic` env override (`RED_TEAM_LLM_MODEL` or the retired hardcoded
  claude-haiku default) so a working env-driven safety setup doesn't silently flip to fail-closed.
  No env → no seed → blank fails closed legibly. `.env.example` updated.
- Policy route: keyed-provider backstop is now gated on model-CHANGING writes (mirrors the
  reasoning-rule gating) — an unrelated save can no longer 400 on a stored unkeyed model.

**Stage 2 — the one adversary**
- In-flow Bear LLM pass DELETED from `proposeTrades` (~280 lines: prompt/schema/fetch/parse/
  `bearUnavailable` machinery). `deterministicBearFilter` + its audits KEPT (§3.1). proposeTrades
  returns the deterministic-filtered Bull output (R6) + a new `adversaryContext` (R7: the same
  candidate evidence/macro/scorecards/analogs/coaching blocks the Bull saw).
- `debateProposal` (`src/lib/red-team.ts`) REWRITTEN as the single post-sizing reviewer: both jobs
  (fact-check + finalized-size critique, §3.4 size/caps stated upfront), three-way down-only verdict
  (`RED_TEAM_VERDICT_SCHEMA`, strict json_schema / DeepSeek json_object / Anthropic forced tool via
  the shared builder), per-account usage attribution (`connectedAccountId`, PR #1030 coordination).
- `redTeamProvider()` / `RED_TEAM_LLM_PROVIDER` / `RED_TEAM_LLM_MODEL` / `debateViaAnthropic`
  DELETED — a claude-* Red model rides the shared anthropic-messages transport.
- Call site (`strategy.ts`): universal coverage on every RISK-ADDING opening — new exported
  `isRiskAddingOpening` (net-direction-aware, R5: a buy covering a short / a short trimming a long
  is exempt); exits never reach the reviewer (§3.5, structural + an in-function guard); reviews run
  through a 3-wide `mapWithConcurrency` pool (R4); `shouldRunRedTeamDebate`/`redTeamDebateTrigger`/
  conviction+notional thresholds + `tuning.redTeamConvictionThreshold`/`redTeamNotionalPctOfNavThreshold`
  DELETED (O2); verdict `trigger:"all_openings"`.
- `approve-at-half` (R1/R2): `applyRedTeamHalfSize` mutates IN PLACE (reference identity feeds
  `requiresHumanReview`) — quantity-routed orders halve shares (floor; <1 share unplaceable),
  dollar-routed orders halve notional (bracket-invalidating sub-share half unplaceable); an
  unplaceable half is HELD for human review at full size (never up-sized, never silently full-size).
  Audits: `red_team_approved_at_half` / `red_team_half_size_unplaceable`.
- R8: a reviewer rejection persists a `trade_proposals` row (status `"rejected_by_red_team"`,
  decision reasons carry the veto) before the drop; existing veto audit + counterfactual unchanged.

**Stages 3–4 — reliability + visibility**
- `fetchLlmWithRetry` (`llm-request.ts`): bounded same-model retry (2 attempts, 500ms backoff,
  fresh per-attempt timeout signal) on 429/5xx/timeouts ONLY; NO hidden model failover (R11 option
  b — the spec's failover step is dropped rather than inventing an implicit backup).
- `extractJsonPayload` applied at EVERY strategy-path parse site: the Bull parser (R10), the
  reviewer, `proposal-revalidation`, `strategy-tuning`. §4.4 shape validation fails closed on any
  verdict outside the exact three-member set. §4.6 parse-failure logs include a 200-char raw prefix
  + refusal heuristic.
- Token caps consolidated: `strategyCritique` + `redTeamDebate` → `adversaryReview` (§7).
- R18/R19: `PolicyDecision.adversaryUnavailable` (+reason) persisted on BOTH the propose-mode and
  requiresHumanReview inserts (and the haircut recorded in `decision.reasons`); notification payload
  carries `adversaryUnavailable`/`adversaryUnavailableReason` on both branches (§5.2);
  `formatNotificationDisplay` appends "— Red Team Unavailable" instead of overwriting; the approval
  card gets an amber "Red Team review unavailable" panel (reads the persisted verdict first, the
  stored decision flag as fallback) plus verdict-aware copy ("approved at HALF size").
- `tuning.deRiskExitsOnAdversaryUnavailable` is VESTIGIAL (exits never reviewed → flag unreachable);
  kept for JSON round-trip, documented in types.
- Prompt: `buildBearSystem` → `buildRedTeamReviewSystem` (direction-aware BEAR/skeptical-BULL
  framing, both jobs, three-verdict contract); `STRATEGY_PROMPT_VERSION` → `agentic-strategy@2.0.0`.

**Stage 5 — tests**
- Rewritten/updated: `red-team.test.ts` (three-verdict contract, fenced-JSON tolerance, retry
  behavior incl. 429→success recovery, no-model/no-key/exit guards, request bounds, Claude routing),
  `strategy-bear-fail-closed.test.ts` (all four failure modes through the single reviewer, blank-Red
  fail-closed, R19 decision flag), `redteam-failure-routing.test.ts` (exits structurally exempt),
  `redteam-observability-g10.test.ts` (bull + N review generations, no bear),
  `strategy-money-path-f-g.test.ts`, `strategy-episodic-injection.test.ts` (R7 parity via the
  review payload), `strategy-prompt-safety.test.ts`, `persistence-notification.test.ts`,
  `reconciliation-risk.test.ts` (gate tests → `isRiskAddingOpening` net-direction suite),
  `usage-budget*.test.ts`, `policy-notification-events.test.ts` (keyed-backstop seeding),
  `chat-llm.test.ts` (explicit `CHAT_LLM_MODEL`), `antigravity-cheap-wins.test.ts`
  (env-selector suite deleted), `run-strategy-offline.test.ts`.

## Verification (run on the branch, Linux x64 — same platform as the `verify` CI gate)
```
npx tsc --noEmit    # exit 0
npx eslint . --cache# exit 0 (337 grandfathered warnings, 0 errors)
npx vitest run      # 284 files / 2,888 tests — all pass (run in two chunks)
npm run build       # NOT run here: the Cowork sandbox hard-kills any process at 45s (Next build
                    # needs minutes). land.sh re-runs tsc → test → build on macOS before pushing —
                    # that is the authoritative build check for this branch.
```

## Files touched (stages 1b–5)
Code: `src/lib/strategy.ts`, `src/lib/red-team.ts` (rewrite), `src/lib/strategy-prompts.ts`,
`src/lib/llm-request.ts`, `src/lib/llm-required.ts`, `src/lib/types.ts`, `src/lib/defaults.ts`,
`src/lib/db.ts` (migration v15), `src/lib/usage-budget.ts`, `src/lib/ops-snapshot.ts`,
`src/lib/dashboard-ui.ts`, `src/lib/proposal-revalidation.ts`, `src/lib/strategy-tuning.ts`,
`app/api/policy/route.ts`, `app/api/strategy/run/route.ts`, `app/console/settings/models.tsx`,
`app/console/components/approval-card.tsx`, `app/console/lib/models.ts`, `.env.example`.
Tests: listed under Stage 5. Docs: this note, the spec banner, `docs/phase-7-strategy.md`,
`STATUS.md`, `docs/EFFORT-LOG.md`, `PLAN.md`, the Monet handoff note (marked reconciled).

## Follow-ups / deferred
- §4.5 reasoning-effort timeout bonus: deferred (fixed timeout fails safely).
- `tuning.deRiskExitsOnAdversaryUnavailable` removal after soak.
- Owner must PICK BOTH MODELS in Settings → LLM models after deploy for any account without them
  (accepted migration consequence; runs fail closed with an actionable message until then). Env-
  override deployments are seeded by migration v15 instead.
- Landing: the Cowork sandbox cannot push or run `npm run build`; the Mac-side Claude helper (per
  its standing #ag***-s**c offer) runs `scripts/land.sh` from a synced worktree of this branch.
