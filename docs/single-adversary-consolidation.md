# Single-Adversary Consolidation — Design Spec

> **Status: IMPLEMENTED 2026-07-07** (branch `monet/single-adversary-consolidation`, MONET —
> Stage 1a authored by the Cowork Claude session and reconciled onto current `origin/main`;
> supersedes preservation draft PR #1035). Verified: the in-flow Bear LLM pass is deleted,
> `debateProposal` is the single post-sizing reviewer with the three-way
> `approve`/`approve-at-half`/`reject` verdict, `extractJsonPayload`/`fetchLlmWithRetry`/
> `adversaryUnavailable` all exist in `src`, and the full R1–R20 reconciliation below is coded as
> amended by the owner revision. Implementation deltas from this spec (all owner-revision-driven or
> option-(b) choices the spec allowed): no backup-reviewer failover (R11 option b — bounded
> same-model retry only, no hidden fallback); verdict `trigger` records `"all_openings"` (universal
> coverage made the stakes-scaled dissent triggers moot; legacy values remain readable);
> `tuning.deRiskExitsOnAdversaryUnavailable` is vestigial (exits are structurally exempt — §3.5 made
> the opt-in unreachable); Red-Team rejections persist as `trade_proposals` status
> `"rejected_by_red_team"` (R8). See
> `docs/rollouts/2026-07-07-single-adversary-consolidation-impl.md` for the full record.

> **⚠️ OWNER REVISION 2026-07-07 — supersedes the independence design below.**
> The owner reversed the "hard independence" model. These decisions now govern and
> **override** §3.8, §8, O4, R12–R14 wherever they conflict:
> - **No model default for ANYTHING, ever.** Delete every default/fallback:
>   `resolveOpenAiModel`'s hardcoded Green default, `resolveRoleModel`'s
>   fall-back-to-Green, `CROSS_FAMILY_RED_TEAM_DEFAULT` / provider→default-model
>   maps (R13), and the `RED_TEAM_LLM_PROVIDER` env default. A model is used only
>   if the user explicitly chose it.
> - **Both Green and Red models are mandatory and explicitly chosen.** It must be
>   *impossible* to run without both set: enforce at settings-save (`app/api/policy`
>   validation) and in the Settings UI, and fail-closed at runtime if somehow unset
>   (belt-and-suspenders, but the UI makes unset unreachable).
> - **Only models the user holds a key for are selectable in Settings.** Gate the
>   Green/Red model dropdowns to providers with a configured key (per
>   `resolveLlmCredential` / `getUserApiKey`).
> - **Same model for both is ALLOWED** if the user picks it. Drop the hard
>   same-model prohibition (§3.8a) and the write-time exact-model-independence
>   enforcement (R14). No auto-different-provider defaulting (§3.8b). Independence
>   is the user's choice, optionally *nudged* by a non-blocking Settings hint — never
>   enforced. (Matches the repo philosophy: guardrails are adjustable preferences,
>   not a cage.)
> - **Still true from the original spec:** one adversarial LLM call doing everything
>   both calls did (delete in-flow Bear, build on the post-sizing `debateProposal`
>   site), kill the `RED_TEAM_LLM_PROVIDER` env override, exits never reviewed
>   (§3.5), all-openings coverage (§3.6), never-silent failure (§3.7), and the §4
>   reliability fixes + §5–§7 visibility/persistence (R1–R20).
>
> **Scope:** This app is a **paper-trading research / education tool**. A
> "Green Team" / Bull model proposes trades; one or more adversarial models
> critique them. This spec collapses today's **two** adversarial passes into
> **one** and hardens it against the reliability, independence, and visibility
> failures documented below.
>
> **Name — DECIDED (2026-07-01): "Red Team".** The consolidated adversary is the
> **Red Team**. Some sections below still use the leftover placeholder **"Adversary
> Review"** — read every such instance as **"Red Team"**. Keeping the existing name
> is deliberate and low-churn: the code already calls this path *Red Team*
> (`redTeamLlmModel`, `redTeamProvider`, `RED_TEAM_*`), and consolidation deletes
> the *other* thing that shared the name (the in-flow Bear), so "Red Team" now
> refers unambiguously to the single surviving adversary. See [§9](#9-decisions) O1.
>
> **Related docs (do not silently replace):** `docs/phase-7-strategy.md` (the
> owning phase doc for the strategy engine),
> `docs/rollouts/2026-06-21-adversarial-review-bug-fixes.md`,
> `docs/rollouts/2026-06-23-green-red-llm-routing.md`,
> `docs/rollouts/2026-06-30-strategy-llm-timeout-diagnostics.md`. This is a
> **net-new** design doc; it does not supersede any of the above.
>
> **Line-number note:** file:line anchors below are the intelligence-pack
> anchors that this spec was verified against. Some have drifted by a few to
> ~19 lines relative to the current worktree HEAD due to unrelated upstream
> merges (PR #278 sizing work, etc.). Where drift is known it is called out.
> Treat the cited **symbol names** (function/constant/prompt identifiers) as the
> authoritative anchors and re-grep before editing.

> **Stale premise note (2026-07-03):** This document's `test/local` mode no
> longer exists — `policy.paperMode` and the local simulator were removed
> entirely (see `docs/rollouts/2026-07-03-remove-paper-default-test-mode.md`).
> There are now only two execution modes, `broker/paper` and `broker/live`,
> both derived purely from a connected account's `environment`; per this
> doc's own table both already fail closed under `decide` authority via
> `requiresHumanReview`, so the "silent test/local bypass" problem this doc
> analyzes no longer exists. Any unresolved decision here that was
> specifically about `test/local` behavior is moot; treat the rest of this
> document as a historical design record for the parts that still apply (the
> general single-adversary-independence work), not as a description of
> current execution modes.

---

## 1. Problem / motivation

Three distinct problems converge here.

### 1.1 Two adversaries that are the same model run twice

There are currently **two** adversarial LLM passes over every proposal path:

1. **In-flow "Bear"** inside `proposeTrades` — `src/lib/strategy.ts:1813-2440`
   (Bear block ~`2225-2440`). Runs a second LLM call inside proposal
   generation.
2. **Standalone `debateProposal`** — `src/lib/red-team.ts:44-199`, invoked from
   the `sizedProposals` loop at `src/lib/strategy.ts:447-464`.

Both resolve their model from the **same** `policy.redTeamLlmModel` field via
`resolveLlmEndpoint(policy, userId, url, "red")` — see
`src/lib/strategy.ts:2312-2313` (in-flow Bear) and `src/lib/red-team.ts:53`
(standalone debate). By default, with a single blank `redTeamLlmModel`, **both
passes run the identical model twice** with different prompts. This is
indefensible redundancy: two LLM calls, two token-cap constants
(`LLM_OUTPUT_TOKEN_CAPS.strategyCritique` and `.redTeamDebate`,
`src/lib/llm-request.ts:69-73`, both set to the same default), one net critique.

### 1.2 The `gemini-3.5-flash` reliability failure

The motivating incident: a user configured `gemini-3.5-flash` as the adversary
model. Gemini's OpenAI-compatible endpoint returned a markdown-fenced /
prose-wrapped response instead of bare JSON. The adversary parse path does a
**bare `JSON.parse(text)`** with **zero** fence-stripping
(`src/lib/red-team.ts:172` on the OpenAI-compatible path;
`src/lib/strategy.ts:2327`/`2400` for the in-flow Bear). The parse threw, the
adversarial review **silently failed to run**, and the trade proceeded through a
weaker path with no loud signal. There are **zero retries** anywhere in the
adversary call paths, and the standalone debate deliberately opts **out** of
strict structured output (`openAiJsonObject: true`, `src/lib/red-team.ts:120`)
even for providers that support strict `json_schema`.

### 1.3 The failure is invisible to the user

When the adversary is unavailable and a trade routes to human approval, the user
**cannot distinguish** that pending card from a routine manual-approval one. The
"adversary unavailable" reason lives only in the transient in-memory
`results[].reasons` array (`src/lib/strategy.ts:700`) and never reaches the
persisted proposal record. Worse, `formatNotificationDisplay`
(`src/lib/dashboard-ui.ts:240-266`) **unconditionally overwrites** the
notification title for `pending_approval` events, discarding any custom title
the run might set.

**Goal:** one adversary, reviewing the real (finalized) trade, on all opening
trades, that never fails silently, never blocks a risk-reducing exit, is
provably independent of the proposer, and whose unavailability is visible in
both the notification and the pending-approval card.

---

## 2. Current state (verified, cited)

| # | Fact | Anchor |
|---|------|--------|
| 1 | Two adversarial passes: in-flow Bear inside `proposeTrades`, and standalone `debateProposal`. | `src/lib/strategy.ts:1813-2440` (Bear ~2225-2440); `src/lib/red-team.ts:44-199`; call site `src/lib/strategy.ts:447-464` |
| 2 | Both resolve the model from `policy.redTeamLlmModel` via `resolveLlmEndpoint(...,"red")`. | `src/lib/strategy.ts:2312-2313`; `src/lib/red-team.ts:53` |
| 3 | The in-flow Bear reviews the **pre-sizing** proposal — `proposeTrades` returns before the `.map()` that calls `applyDeterministicSizing`. | `src/lib/strategy.ts:403-436` |
| 4 | The standalone `debateProposal` **already reviews the finalized/post-sizing trade** (after `applyDeterministicSizing` + `enrichOpeningProposal`). **This is the correct anchor to build the single adversary on** — it is not novel work. | `src/lib/strategy.ts:425-464` |
| 5 | `shouldRunRedTeamDebate` gates the standalone debate on `confidenceScore >= threshold` (default 80), with **no** side-based exemption for sell/cover. | `src/lib/strategy.ts:89` (`DEFAULT_RED_TEAM_CONVICTION_THRESHOLD = 80`), `892-919` |
| 6 | The standalone debate **can reject a `sell`** (a risk-reducing exit): the system prompt says "If the proposal is a SELL or SHORT (bearish), you are the BULL", and the caller drops the proposal via `continue`. **This is a hazard.** | `src/lib/red-team.ts:62-63`; `src/lib/strategy.ts:450-453` |
| 7 | Deterministic stop-loss / take-profit exits (`proactiveProposals`) bypass the debate loop entirely — merged separately at `[...fundingSells, ...proactiveProposals, ...debatedProposals]`. | `src/lib/strategy.ts:328`, `510` |
| 8 | `applyDeterministicSizing` special-cases exits (sell/cover): skips opening-sizing, preserves explicit LLM sizes, resolves size-less exits to the full existing position. | `src/lib/strategy.ts:1114-1180` (drifted from cited 1095-1169 per PR #278) |
| 9 | `resolveRoleModel` **silently falls back to the Green model** when `redTeamLlmModel` is blank/unset. | `src/lib/llm-provider.ts:16-19` |
| 10 | `resolveLlmEndpoint` defaults role to `"green"`, calls `resolveRoleModel`, then derives provider from the model name. | `src/lib/llm-provider.ts:30-39` |
| 11 | Hidden `RED_TEAM_LLM_PROVIDER` env var (`redTeamProvider()`) + hardcoded default `claude-haiku-4-5-20251001` route the debate to a special Anthropic branch. | `src/lib/red-team.ts:40-42`, `92-107`, `210` |
| 12 | Settings UI actively presents blank / "Same as Green Team model" as a normal, encouraged choice — conflicts with the new hard-independence rule. Doc-comment at `types.ts:402` also documents the fallback as intended. | `app/dashboard-client.tsx:4369` (hint), `4380` (`<option value="">Same as Green Team model</option>`), `4843` (KeyVal); `src/lib/types.ts:402` |
| 13 | Fail-closed to human review only triggers under **`decide`** authority AND **not** `usesLocalSimulation`; branch order is propose-authority → `usesLocalSimulation` → `requiresHumanReview`. | `src/lib/strategy.ts:654-662`, `664-684`, `690-698` |
| 14 | **Correction to a common assumption:** only `test/local` (the app's own simulator) bypasses the fail-closed gate — and it bypasses **silently**. `broker/paper` (Alpaca Paper, Robinhood paper) has `usesLocalSimulation:false` and **already fails closed exactly like `broker/live`**. There is no existing "loudly flagged" behavior for `test/local`. | `src/lib/execution-mode.ts:41-71` |
| 15 | Bare `JSON.parse` on adversary responses, no fence-stripping. In-flow Bear falls back to Bull proposals on parse failure (fail-**open** to unreviewed proposals). OpenAI-path `debateProposal` parse errors are caught by the outer try and reported `available:false`. The Anthropic sub-path has a crude brace-regex that incidentally tolerates a fence; the OpenAI-compatible path (which Gemini uses) does **not**. | `src/lib/strategy.ts:2400`; `src/lib/red-team.ts:172`, `263` |
| 16 | **Zero** bounded retries in any adversary call path. | `src/lib/red-team.ts`, `src/lib/strategy.ts` |
| 17 | `debateProposal` forces `openAiJsonObject: true`, deliberately opting **out** of strict `json_schema` even for Gemini/xAI/Mistral that support it — unlike the bull/bear proposal calls which get strict schema. | `src/lib/red-team.ts:120`; `src/lib/llm-call.ts:115-121`; contrast `src/lib/strategy.ts:2044`, `2261` (drifted from cited 2121/2342 — re-grep by symbol) |
| 18 | `formatNotificationDisplay` unconditionally overwrites the `pending_approval` title. | `src/lib/dashboard-ui.ts:240-266` (branch ~254-255) |
| 19 | The pending-approval card renders in `pending.map()`; the amber "OAuth Needed" chip idiom (`bg-amber-500/10 border-amber-500/20 text-amber-400`) exists to match. | `app/dashboard-client.tsx:2264-2340` (card); `6668-6671` (chip) |
| 20 | The persisted `decision` object (`insertProposal`/`updateProposalStatus`) does **not** carry adversary-unavailable status — the `decision` is the output of `evaluateTradeProposal` (risk/policy check), independent of adversary availability. The reason lives only in transient `results[].reasons`. | `src/lib/strategy.ts:550-565`, `690-698` |
| 21 | `PolicyDecision` has a `reasons: string[]` field usable to persist the flag with **no schema migration**; `insertProposal` accepts `decision: unknown`, `updateProposalStatus` accepts `decision?: PolicyDecision` (JSON-stringified into the same column). | `src/lib/types.ts:838-843`; `src/lib/db-proposals.ts:148-158`, `256-271` |
| 22 | `NOTIFICATION_EVENT_TYPES` is a 9-member const array; `NotificationEvent.payload` is typed `unknown` — adding an adversary-unavailable payload flag needs **no** type-union migration. | `src/lib/types.ts:30-41` (`NOTIFICATION_EVENT_TYPES`), `1127-1136` (`NotificationEvent`) |

---

## 3. Target design — the single Adversary Review

### 3.1 One reviewer, built on the post-sizing call site

Collapse both passes into **one** adversary. **Build it by extending the
existing post-sizing `debateProposal` call site** at
`src/lib/strategy.ts:447-464` — this loop already runs after
`applyDeterministicSizing` and `enrichOpeningProposal`, so it already sees the
finalized quantity/size/stop/limit. This is a **replace/extend**, not a
from-scratch invention.

Delete the entire **in-flow Bear** pass inside `proposeTrades`
(`src/lib/strategy.ts:~2225-2440`): `bearSystemPrompt`, `bearSchema`,
`bearUserContent`, the `resolveLlmEndpoint(...,"red")` call, the bear
fetch/parse, and `bearProposals`. `proposeTrades` should return the Bull /
deterministic-filter output directly with **no second LLM call**.

**Scope the deletion to the LLM Bear call ONLY.** The pre-sizing block also
houses non-redundant *deterministic* critique that is NOT part of the redundant
second LLM pass and MUST be retained: the phantom-exit veto, the
momentum-overextension rationale annotation, and any regime-contradiction veto
(the pre-filter rules around `src/lib/strategy.ts:~902-919` and the deterministic
vetoes near the bear block). These run pre-sizing and shape the proposal the
single adversary later sees; deleting them along with
`bearSystemPrompt`/`bearFetch` would leave the one remaining LLM adversary
strictly weaker (it is an LLM that, per the code's own comment, shares the Bull's
family). Delete only the LLM-call machinery; keep the deterministic pre-filter.

### 3.2 Reviews the finalized trade

The adversary reviews the trade **after `applyDeterministicSizing`**, so it sees
the real quantity, notional, stop, and limit — not the pre-sizing fiction the
in-flow Bear currently reviews. (The standalone path already does this; the
change is that this becomes the **only** path.)

### 3.3 Verdict set — exactly three, discrete and down-only

The adversary returns exactly one of:

| Verdict | Effect |
|---------|--------|
| `approve` | Proceed at the deterministically-sized notional. |
| `approve-at-half` | Proceed at **0.5× the deterministically-sized notional** — one discrete, logged, down-only haircut. |
| `reject` | Drop the proposal (route to human per the failure/authority policy — see §3.7). |

**No free-form / continuous confidence multiplier.** A continuous LLM-driven
size multiplier is explicitly rejected because it would (a) double-count
conviction, which the deterministic sizer already applies at
`src/lib/strategy.ts:1126-1141`; (b) let an uncalibrated LLM number set real
risk; and (c) reintroduce non-determinism. "Half" is the single allowed
haircut.

**The sizer stays the sizing baseline.** The adversary can only **reduce-to-half
or reject** — never increase, never re-size upward.

**Implementing `approve-at-half`:** mutate the finalized proposal via object
spread — `{ ...proposal, dollarAmount: proposal.dollarAmount * 0.5, quantity: undefined }`
— so the non-optional `tradeThesisTag` / `entryMarketRegime` fields
(`src/lib/types.ts:596-597`) are preserved automatically, and post-sizing
notional-routing (which requires `quantity` be `undefined`,
`src/lib/strategy.ts:~1218-1225`) is not broken by a stray quantity. **Never
reconstruct a `TradeProposal` literal** (see
[§10](#10-cross-file-traps--verification-checklist)).

**Do NOT naively multiply the notional — re-check placeability first.** The
sizer's bracket-minimum / whole-share / floor clamps
(`src/lib/strategy.ts:~1189-1199`) already ran *before* the haircut and will
**not** re-run on the spread-mutated object. A blind `0.5×` can therefore (a)
silently drop the order below its native broker bracket minimum, or (b) round to
a sub-share / zero-share order. After computing the halved notional, re-run the
bracket / whole-share / floor checks; if `0.5×` is **not placeable, no-op the
haircut** and log `haircut skipped: would breach bracket/share minimum` in
`decision.reasons`. Record every applied *and* skipped haircut so the down-only
guarantee is never silently defeated by a downstream clamp.

### 3.4 The prompt tells the model the size and caps upfront

The adversary prompt is **told the deterministic size and the hard caps
upfront**. This fixes the current incoherence where the LLM reasons about a size
that a hard deterministic rule then silently overrides. The model critiques the
**actual** trade it will affect.

### 3.5 Side / exit scope — risk-adding trades only

The adversary runs on **risk-adding opening trades only: `buy` and `short`.**

Exits — **`sell` and `cover`** — are **EXEMPT**. The adversary must **NEVER** be
able to block or shrink a risk-reducing trade. Vetoing a stop-loss or
take-profit is the single action that makes the system *less* safe, so it is
structurally forbidden:

- Exits must **never** be passed to the adversary at all. They fall straight
  into `debatedProposals` unmodified.
- This **fixes the current hazard** (Fact #6): today `debateProposal` can reject
  a `sell` via `red-team.ts:62-63` → `strategy.ts:450-453`.
- The rewritten prompt **drops** the "If the proposal is a SELL or SHORT
  (bearish), you are the BULL" framing entirely, since exits no longer reach the
  function.
- Deterministic proactive exits already bypass the loop (Fact #7); that stays.

At the call site (`src/lib/strategy.ts:446`), gate on **net risk direction, not
raw side.** Send to the adversary only trades that *increase* `|net position|`
in the symbol (a `buy`/`short` that OPENS or ADDS exposure). **Exempt** any trade
that *reduces* net exposure — not only `sell`/`cover`, but also a `buy` that
covers an existing short or a `short` that trims an existing long (look up the
existing position exactly as `applyDeterministicSizing` already does at
`src/lib/strategy.ts:~1114`). Raw-side gating alone (`side === "buy" || "short"`)
would wrongly route a net-reducing buy/short to the adversary, which could then
reject or half-size a genuinely risk-reducing trade — defeating the very
guarantee §3.5 promises to make structural. For any exempt trade, skip the
adversary call and pass it through untouched.

> **Narrow but real:** the system rarely emits opposite-side trades on names it
> already holds, so this window is small — but it is exactly the
> position-flip / net-exposure edge case that makes "reduces risk" ≠ "is a
> sell/cover." If net-direction lookup is deferred, document it as an explicit
> accepted risk rather than leaving the §3.5 guarantee silently false.

### 3.6 Coverage — all openings, not conviction-gated

Run the adversary on **all** opening trades (`buy`/`short`), **not**
conviction-gated. The old high-conviction-only gate
(`DEFAULT_RED_TEAM_CONVICTION_THRESHOLD = 80`, `src/lib/strategy.ts:89`) was
never a real cost saving: the adversary costs ~$0.0035/call, ~$0.07/day typical.

**Recommendation:** remove the conviction gate. Repurpose or delete
`shouldRunRedTeamDebate` so it gates **only** on `side === "buy" || "short"`,
dropping the `confidenceScore` check. If the gate is removed, also drop the
now-dead `tuning.redTeamConvictionThreshold` policy field and its Settings UI
slider (`app/dashboard-client.tsx:5296-5298`) — see the cross-file trap in §10.

> **DECIDED (2026-07-01):** remove the conviction gate entirely (run on all
> openings). See [§9](#9-decisions) O2.

**Latency, not just dollars.** Universal coverage multiplies the number of
adversary calls per run, and the debate loop is today a **sequential
`for...await` inside the per-user scheduler lock** (acquire
`src/lib/strategy.ts:161` → loop `445-463` → release `881`). Combined with §4.3's
retry/failover, worst-case added lock-hold is
`openings × (timeout × retries + failover_timeout)` — a real scheduler-starvation
risk (the same failure the hard per-call timeout exists to prevent). **Mitigation:
run the openings' adversary calls concurrently** (`Promise.all` with a small
concurrency cap, e.g. 3–4) since they are independent per-proposal, and/or keep a
modest cap on openings reviewed per run. Removing the gate is only clean *with*
this concurrency change — state the latency budget next to the ~$0.07/day figure.

### 3.7 Failure policy — never silent

The adversary **never fails silently.** "Cannot run" = error, timeout, or an
unparseable/schema-violating response that survives the reliability fixes in §4.

Use the codebase's **real three-way execution distinction** (Fact #14), not a
binary paper-vs-live split:

| Execution mode | On adversary-unavailable |
|----------------|--------------------------|
| **`broker/live`** (real broker, live) under `decide` authority | **FAIL CLOSED** → human approval. |
| **`broker/paper`** (Alpaca Paper, Robinhood paper) under `decide` authority | **FAIL CLOSED** → human approval. (Already the behavior today via `strategy.ts:690-698` — no new logic, just ensure the new adversary sets `requiresHumanReview` consistently.) |
| **`test/local`** (app's own simulator) | **MAY execute, but LOUDLY flagged.** |

> **Important:** today `test/local` bypasses the fail-closed gate **silently**
> (`usesLocalSimulation` branch, `src/lib/strategy.ts:664-684`, auto-fills
> unconditionally). The "loudly flagged" behavior is **new work**, not a
> description of current behavior. Add a loud audit entry + notification flag
> (see §5–§7) when `test/local` auto-executes an adversary-unavailable trade.
>
> An open sub-decision: whether `test/local` keeps auto-filling (with a loud
> flag) or also routes through `requiresHumanReview`. **Recommended: route
> `test/local` adversary-unavailable through `requiresHumanReview` too**, so the
> single §5 visibility path (badge + notification flag + persisted reason) covers
> all three modes with one code path. The auto-fill-but-flag alternative is a
> trap: `test/local` auto-executes at `src/lib/strategy.ts:664` and emits a
> `fill` notification (`~682`) — it **never reaches** the `requiresHumanReview`
> branch (`693`) that the entire §5 machinery is wired to. So a "loud flag" left
> on the auto-fill path would be as invisible as the silent behavior it replaces.
> If auto-fill is kept for frictionlessness, the flag MUST be wired *separately*
> into the `fill` notification payload (`~682-686`) and the auto-filled
> proposal's `decision.reasons` at insert (`~666`) and surfaced on the fill card
> — extra duplicate wiring §5 does not otherwise describe. See §9 O3.

Consistency requirement: the new single adversary must set `requiresHumanReview`
across **all three** failure modes (error / timeout / unparseable), not just one.

### 3.8 Independence enforcement

Three layers, in order of strictness:

**(a) HARD rule — adversary model ≠ proposer model, exactly.**
A blank `redTeamLlmModel` must **no longer** silently fall back to the Green
model. Change `resolveRoleModel` (`src/lib/llm-provider.ts:16-19`): for
`role === "red"`, a blank/unset value must **not** return
`resolveOpenAiModel(policy)` (the Green model). Instead either:
- (a1) treat it as **"adversary not configured"** → fail-closed per §3.7, **or**
- (a2) **auto-select a different-provider default** per (b) below.

The recommended behavior is (a2) when a second provider key is available, else
(a1). Also update the doc-comment at `src/lib/types.ts:402` which currently
documents the fallback as intended.

**(b) STRONG default + warning at the company/provider level — NOT a hard
block.**
Default the adversary to a **different provider** when a second key is
available. Reuse the existing per-provider credential check: iterate
`LLM_PROVIDER_SERVICES` via `resolveLlmCredential` / `getUserApiKey`
(`src/lib/db-api-keys.ts:448-471`) to find an available different-provider key,
and use it as the strong default for a still-unset adversary model.

When both sides resolve to the **same company/provider**, show a **warning
chip** in Settings — do **NOT** hard-block. A single-provider user must still be
able to run the adversary; hard-blocking on company would route everything to
human approval, which is a footgun. The warning surfaces in Settings; it is
**not** enforced inside `resolveLlmEndpoint`.

> **Say "allowed but weak" explicitly.** The hard rule (a) forbids only the
> *exact same model*, so a single-provider user can comply with two different
> models from one family (e.g. green `gpt-5.5`, red `gpt-5.4-mini`) — which still
> shares most blind spots. The warning-chip copy must state that
> different-model-same-provider *partially* achieves independence, so the absence
> of a hard block isn't read as an all-clear. Also spell out the O4 UX cliff: a
> **blank** field (→ unconfigured → human approval) is functionally "worse" than
> a weak same-family pick — Settings copy should make both states legible.

**(c) KILL the hidden env override.**
Delete `redTeamProvider()`, the `RED_TEAM_LLM_PROVIDER` / `RED_TEAM_LLM_MODEL`
env reads, the special-cased Anthropic branch (`src/lib/red-team.ts:33-42`,
`92-107`), and the hardcoded `claude-haiku-4-5-20251001` default
(`src/lib/red-team.ts:210`). Replace with a **first-class "adversary
model/provider" Strategy Studio setting** so Settings always tells the truth.
The Anthropic forced-tool path is still valuable (it is the most reliable
structured-output mechanism — see §4) but it must be selected by the resolved
**model/provider**, not by a hidden env var.

---

## 4. Reliability fixes

These are the root-cause fixes for the `gemini-3.5-flash` failure. Fold the
model-selection guidance into §6.

### 4.1 Strip markdown code fences before `JSON.parse` (shared helper)

Add one shared helper in `src/lib/llm-call.ts` near `extractLlmText`
(`~:142`):

```ts
export function extractJsonPayload(text: string): string {
  const trimmed = text.trim();
  // strip a leading ```json / ``` and trailing ``` fence
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  // fall back to the first balanced object/array block
  const match = unfenced.match(/[[{][\s\S]*[\]}]/);
  return (match ? match[0] : unfenced).trim();
}
```

Promote the weaker brace-regex that already exists **only** on the Anthropic
sub-path (`src/lib/red-team.ts:258-259`, `text.match(/\{[\s\S]*\}/)`) into this
shared helper and apply it **everywhere** an LLM response is parsed:

- `src/lib/red-team.ts:172` (OpenAI-compatible path — the Gemini failure site).
  **Give it its own local `try/catch`** (matching the well-behaved
  `strategy.ts` pattern) instead of relying on the outer try, which produces a
  generic "Red Team evaluation errored out." with no diagnostic.
- `src/lib/red-team.ts:258-263` (Anthropic path — use the shared helper).
- `src/lib/strategy.ts:2327`/`2400` (in-flow Bear — being deleted, but if any
  residual parse survives, use the helper).
- Also apply to the two unrelated LLM parse sites for defense-in-depth:
  `src/lib/proposal-revalidation.ts:277`, `src/lib/strategy-tuning.ts:489`.

Every call site replaces bare `JSON.parse(text)` with
`JSON.parse(extractJsonPayload(text))` inside a `try/catch` that returns its
existing fail-closed / fallback shape.

### 4.2 Enforce structured output where supported

Remove `openAiJsonObject: true` from the adversary's `buildLlmRequestBody` call
(`src/lib/red-team.ts:120`). This currently disables strict `json_schema` even
for Gemini/xAI/Mistral, which do support it via the same OpenAI-compatible
transport (`src/lib/llm-call.ts:115-121`:
`if (schema && !openAiJsonObject && provider !== "deepseek") return json_schema…`).

**Trap:** DeepSeek is special-cased (`provider !== "deepseek"`). Simply deleting
the flag must be checked against every provider `resolveLlmEndpoint` can route
to (openai/anthropic/xai/gemini/mistral/deepseek). Deleting the flag re-enables
strict `json_schema` for everyone except DeepSeek (which stays on the fallback),
which is the intended outcome — but verify DeepSeek still parses cleanly.

Structured output is a *request*, not a guarantee, on OpenAI-compatible shims
(§4.5), so the fence-stripping in §4.1 stays as defense-in-depth even with
strict schema enabled.

### 4.3 Bounded retry + failover before declaring unavailable

There are currently **zero** retries (Fact #16). Add a small bounded-retry
wrapper, e.g. `fetchLlmWithRetry(url, init, { attempts: 2, baseDelayMs: 500 })`,
next to `llmFetch` in `src/lib/llm-request.ts:55`. Retry only on transient
status (`429`, `502`, `503`, `504`), with exponential backoff **capped so total
wall-clock stays well under** the timeout. `humanizeLlmError`
(`src/lib/llm-errors.ts:66-67`) already classifies 429/quota — reuse it or do a
light local status check.

Keep attempts **small (1–2)**: the adversary runs inside a per-user scheduler
lock (`src/lib/llm-request.ts:45-48`), so aggressive retries starve the
scheduler and defeat the reason the hard timeout exists.

Additionally, **fail over to the configured backup adversary model** (a
different provider per §3.8b) before declaring `available:false`. Order:
retry same model → failover to backup model → declare unavailable → apply §3.7.

Swap the direct `llmFetch` calls at `src/lib/red-team.ts:149` and the (soon
deleted) bear step `~src/lib/strategy.ts:2307` for the wrapper.

### 4.4 Validate the parsed shape — fail closed, not fail open

Today `src/lib/red-team.ts:176` does `rejected: !!parsed.rejected`, which
silently coerces a **missing** `rejected` field to `false` (approve) — the wrong
fail-direction for a risk reviewer. After parse, **require the expected keys**
(the three-verdict field, plus `reason`) with the right types; on a shape
mismatch, treat it the same as a parse failure (unavailable → §3.7), not as an
implicit approve.

**Unknown / missing verdict = fail-closed.** Enumerate the exact verdict field
and its allowed values (`approve` / `approve-at-half` / `reject`). Any value
**outside** that set — or a missing verdict, even inside otherwise well-formed
JSON — maps to **unavailable → §3.7 (fail-closed)**, never silently to `approve`
or `approve-at-half`. (A risk reviewer that returns `approve_with_caution` must
not be read as `approve`.)

### 4.5 (Nice-to-have) scale timeout by reasoning effort

`REASONING_TOKEN_BUDGET` (`src/lib/llm-request.ts:34-38`) raises the *token* cap
for reasoning models but the wall-clock timeout stays fixed, so a legitimately
slow high-effort answer can be killed at 45s/60s and misread as a failure. Add a
`REASONING_TIMEOUT_BONUS_MS` map (low: 0, medium: 15_000, high: 45_000) and add
the bonus to `RED_TEAM_TIMEOUT_MS` when `policy.llmReasoningEffort === "high"`.
Low priority — the current fixed timeout fails safely, just sometimes
unnecessarily.

### 4.6 (Nice-to-have) log raw text on parse failure to distinguish refusals

A safety-filter refusal returns HTTP 200 with an English apology, which
currently manifests identically to malformed JSON. In the parse `catch` blocks,
include `text.slice(0, 200)` in the log and optionally flag apparent refusals
(`/^(i can'?t|i cannot|i'm not able|as an ai)/i`) in the operator-facing reason,
so "the model refused" is distinguishable from "malformed JSON."

---

## 5. UI / visibility changes

### 5.1 Distinct warning badge on the pending-approval card

Add an amber warning chip/badge on the pending-approval card
(`app/dashboard-client.tsx:2264-2340`, near the existing `stoppedActionReason`
warning block ~2325-2333) when the proposal is pending **because the adversary
was unavailable**. Style it to match the existing "OAuth Needed" chip idiom:
`bg-amber-500/10 border-amber-500/20 text-amber-400`
(`app/dashboard-client.tsx:6668-6671`). This is **genuinely new UI** — there is
no existing adversary-unavailable badge.

The badge's source of truth is the persisted decision flag (§7) and/or the
notification payload flag (§5.2), read defensively.

### 5.2 Notification title + payload flag

`formatNotificationDisplay` (`src/lib/dashboard-ui.ts:240-266`, branch ~254-255)
**unconditionally overwrites** the `pending_approval` title. Change it to
**not** overwrite (or to append an indicator) **when a payload metadata flag is
present**, e.g. `payload.adversaryUnavailable`.

Add the metadata flag to the `sendNotification` payload in the
`requiresHumanReview` branch (`src/lib/strategy.ts:693`), whose payload is
currently `{ runId, proposalId, refId, proposal: normalizedProposal, review }`.
Add `adversaryUnavailable: true` and `adversaryUnavailableReason: string`.

`NotificationEvent.payload` is `unknown` (`src/lib/types.ts:1134`), so **no type
migration** is needed. Extend `dashboard-ui.ts`'s existing `asRecord(payload)`
reader to read the new fields — do **not** assume a typed shape (stay consistent
with that file's defensive parsing).

**Lower-risk than a new event type:** surface the reason via a payload flag on
the **existing `pending_approval` type**, not a new `NotificationEventType`
discriminant.

---

## 6. Settings help / tips copy

Add Strategy Studio guidance (near the adversary-model Field,
`app/dashboard-client.tsx:4342-4390`, and/or the summary card ~4820-4845) about
which models suit the structured-JSON adversarial-critique role, tied directly
to the §4 reliability fixes. The `Field` component renders `hint` via a
`HelpTip` tooltip (`app/ui/primitives.tsx:261-282`) — keep copy tooltip-length.

Recommended copy (adapt to the final placeholder name):

> **Adversary Model — choosing a reviewer**
>
> This model's only job is to output one strict JSON verdict — nothing else.
> Reliability here means "always returns parseable, schema-shaped JSON," not
> "smartest model." A model that ignores the schema even 1% of the time
> silently disables your risk review for that trade.
>
> **Best fits:**
> - **Anthropic Claude (any tier)** — the app forces Claude to answer via a
>   single required tool call, so the JSON shape is enforced by the API itself,
>   not just requested. Most reliable option, good even at the cheapest tier.
> - **OpenAI gpt-5.4 / gpt-5.4-mini / gpt-5.5** — native Structured Outputs
>   rarely deviate from the schema.
>
> **Use with caution:**
> - **Gemini, Grok, Mistral, DeepSeek** talk to the app through an
>   OpenAI-compatible endpoint; their schema enforcement is best-effort
>   emulation, not a hard guarantee. Smaller/cheaper tiers (Flash-lite, budget
>   Grok/Mistral) are the most likely to return prose, a fenced code block, or
>   JSON missing a required field. **This is exactly what happened with
>   `gemini-3.5-flash`** — it returned an unparseable format and the adversarial
>   review silently failed to run.
> - If you pick one of these for cost, prefer the largest / "pro" tier in that
>   family over the flash/lite tier.
>
> **Rule of thumb:** run a cheaper model for the proposer if you like (the trade
> idea tolerates variance), but keep the adversary on Anthropic or OpenAI — or a
> "pro"/large tier of another provider — so the safety check that gates real
> trades doesn't silently go missing.

Also remove the misleading `<option value="">Same as Green Team model</option>`
and the "Leave as same as Green Team for lower friction" hint
(`app/dashboard-client.tsx:4369`, `4380`), and update the summary `KeyVal`
(`4843`) to show a real warning/unset state instead of "Same as Green Team".

---

## 7. Data-model / persistence changes

Persist the adversary-unavailable reason onto the **stored** proposal so it
survives past the run (today it lives only in transient `results[].reasons`,
`src/lib/strategy.ts:700`).

- **No schema migration.** Use the existing `decision` JSON column.
  `PolicyDecision` already has `reasons: string[]` (`src/lib/types.ts:838-843`).
  In the `requiresHumanReview` branch (`src/lib/strategy.ts:690-698`), **append**
  the adversary-unavailable reason into `decision.reasons` (or a new
  `PolicyDecision` field, e.g. `adversaryUnavailable?: boolean`) **before**
  calling `insertProposal`.
- Route through the existing `db-proposals.ts` functions — `insertProposal`
  (`decision: unknown`, `:256-271`) and `updateProposalStatus`
  (`decision?: PolicyDecision`, JSON-stringified, `:148-158`). Do **not** add an
  ad-hoc column (module-per-concern convention, per `CLAUDE.md`).
- The `approve-at-half` haircut should also be recorded in
  `decision.reasons` (or a dedicated field) so the discrete down-only decision
  is auditable.

Consolidate the duplicate token caps (`LLM_OUTPUT_TOKEN_CAPS.strategyCritique`
and `.redTeamDebate`, `src/lib/llm-request.ts:69-73`) into a single key (e.g.
`adversaryReview`) for the one remaining call, and update call sites.

---

## 8. Migration of existing saved policies

Existing rows where `redTeamLlmModel` is **blank/undefined OR exactly equals
`llmModel`** must be treated as **"adversary not independently configured"**
under the new hard-independence rule — not silently reused as the Green model
(which is what happens today).

- Add a normalization/migration step where policy defaults are applied (locate
  via `src/lib/db-settings.ts` or the policy-normalization logic — grep for
  policy migration/normalization; not directly inspected in this pass).
- For each such row: either **auto-default to a different-provider adversary**
  (§3.8b, when a second key exists) or mark it **unconfigured** → fail-closed
  (§3.7).
- **Detect runtime-identical models, not just exact strings.** Compare
  **trimmed, case-normalized** `redTeamLlmModel` vs `llmModel` (and ideally flag
  same-*provider*), matching how `resolveRoleModel` / `resolveLlmEndpoint`
  actually resolve them (`llm-provider.ts:16-18` trims; provider is a
  case-insensitive regex on the model name). `' gpt-5.5 '` vs `'gpt-5.5'`, or two
  casings, are runtime-identical but not `===`-identical and must still be
  caught.
- Existing coverage for this field's persistence lives in
  `test/account-scoped-models-migration.test.ts` and
  `test/per-account-policy-isolation.test.ts` — add assertions there for the new
  behavior.

---

## 9. Decisions

> **All four decisions are now RESOLVED** (O1 named "Red Team" on 2026-07-01;
> O2–O4 decided in the design discussion). The last column records the agreed
> answer, not an unresolved choice. The only item still carrying an
> owner-overridable *default* is O3's pure-simulator (`test/local`) sub-nuance,
> which surfaced from the spec review rather than the design discussion.

| # | Decision | Options | Resolution |
|---|----------|---------|----------------|
| **O1** | **Naming — RESOLVED: "Red Team".** The consolidation makes this trivial — with the in-flow Bear deleted there is no second "Red Team" to disambiguate. Replace the **"Adversary Review"** placeholder throughout this doc with **"Red Team"**. | Owner picked **"Red Team"** (over Conviction Check / Final Sanity Check / High-Conviction Safeguard / Second-Opinion Gate). | **DECIDED (2026-07-01): keep "Red Team".** Low-churn by design: the code already uses `redTeamLlmModel` / `redTeamProvider` / `RED_TEAM_*`, so **no code rename and no DB-value migration** are needed — you keep the existing field/labels and just delete the duplicate (in-flow Bear). A *different* name would have cost ~15+ call-site edits across 4 source + 3 test files plus a saved-policy DB migration — avoided. |
| **O2** | **Universal vs. conviction-gated coverage (CONFIRM-POINT).** §3.6 recommends removing the conviction gate and running on all openings. | Remove gate entirely; **or** keep a default-off gate. | **DECIDED (2026-07-01): remove the gate — run on all openings**, AND run the openings' adversary calls concurrently (§3.6) so universal coverage doesn't extend the scheduler-lock hold. Cost (~$0.07/day) and — with concurrency — latency both stay negligible. Concurrency was a spec-review addition, not a reopening. Deleting `tuning.redTeamConvictionThreshold` + its UI follows. |
| **O3** | **`test/local` on adversary-unavailable.** §3.7. | Route `test/local` through `requiresHumanReview` too (one visibility path); **or** keep auto-filling with a loud flag wired separately into the `fill` notification + proposal row. | **DECIDED core (never-silent + fail-closed in broker modes). Sub-nuance is NEW (from spec review) — default: route `test/local` through `requiresHumanReview`** so the §5 badge / flag / persisted-reason path covers all three modes with one code path; the auto-fill+flag option needs duplicate wiring and is easy to leave invisible. Owner may override to keep the pure simulator frictionless. |
| **O4** | **Blank-adversary behavior when no second key exists.** §3.8a. | (a1) treat as unconfigured → fail-closed; **or** reuse same-provider model with a Settings warning only. | **DECIDED (2026-07-01): (a1) fail-closed** — follows from the agreed independence rule (different model required, different company preferred not forced); the same-provider *different-model* case is allowed but warned. |

---

## 10. Cross-file traps & verification checklist

### Cross-file traps

- **`TradeProposal` construction:** any half-sized or adversary-modified
  proposal **must** use object spread (`{ ...proposal, dollarAmount: … }`), never
  a reconstructed literal, or it violates non-optional `tradeThesisTag` /
  `entryMarketRegime` (`src/lib/types.ts:596-597`). This exact mistake has bitten
  the repo before (per `CLAUDE.md`).
- **48 test files** construct `TradeProposal`-literals with an explicit `side`
  field. Grep `side: "buy"|"sell"|"short"|"cover"` in `test/*.ts` before
  touching the type or adding a halved-size marker field.
- **`db-proposals.ts` module boundary:** new persisted adversary-unavailable
  state goes through `insertProposal` / `updateProposalStatus`'s existing
  `decision` parameter — **no** ad-hoc columns (db-\*.ts module-per-concern
  convention).
- **Migration must catch `redTeamLlmModel === llmModel`** (identical strings),
  not only blank/undefined. Coverage:
  `test/account-scoped-models-migration.test.ts`,
  `test/per-account-policy-isolation.test.ts`.
- **`redTeamLlmModel` is persisted to SQLite** and referenced by ~15+ call sites
  across `strategy.ts`, `red-team.ts`, `llm-provider.ts`, `dashboard-client.tsx`,
  and 3 test files — an O1 rename is a repo-wide find/replace **with a
  DB-value migration path**, not just a code rename.
- **`openAiJsonObject:true` removal** must account for the DeepSeek special-case
  (`provider !== "deepseek"` in `llm-call.ts:115-121`).
- **Removing the conviction gate** must also remove/hide the now-dead Settings
  slider for `tuning.redTeamConvictionThreshold`
  (`app/dashboard-client.tsx:5296-5298`), not just the backend function.
- **`NotificationEvent.payload` is `unknown`** — read new fields through the
  existing `asRecord()` helper in `dashboard-ui.ts`, not by assuming a typed
  shape.

### Test rewrites required

- `test/llm-provider.test.ts:67-76` — currently asserts the exact
  fallback-to-Green behavior §3.8a removes ("falls Red Team back to the Green
  model when no red override is set"). Rewrite to assert no-silent-fallback
  (fail-closed-unconfigured **or** auto-different-provider).
- `test/red-team.test.ts:20-170` — rewrite for the new function name/signature
  and the three-verdict (`approve`/`approve-at-half`/`reject`) shape. **Preserve
  the `available:false`-on-failure semantic** — the fail-open contract tests
  (`:20-59`) are a *function-return contract* (`{rejected:false, available:false}`
  when it can't run), **not** an execution policy; the fail-closed decision is
  made by the **caller** (`strategy.ts`) based on `available`, so §4 does not
  contradict them.
- Any test exercising `proposeTrades`'s bear step (grep `step: "bear"` /
  `bearModel` / `fallbackToBull`) — update/remove once the in-flow Bear is
  deleted.

### Verification gate (required before commit — per `CLAUDE.md` / `AGENTS.md`)

Run all four, in this order:

```bash
npx tsc --noEmit   # type errors first
npm run lint       # eslint flat config (ESLint 9); REQUIRED verify CI step, fails on errors only
npm test           # vitest (~723 tests / 81 files as of 2026-06-21)
npm run build      # full Next.js build; re-checks types and regenerates .next/
```

`npm run build` deletes/regenerates `.next/`; if a dev preview is running,
restart it (`pm2 restart trading-<you>`). The `verify` CI check (a **ruleset**,
not classic branch protection) gates every merge to `main`; merge with
`gh pr merge <n> --squash --auto`.

### Handoff docs (required — Pre-Commit / Handoff Protocol)

Implementation must update, and reference in the commit message:

1. **`STATUS.md`** — state, blockers, next action.
2. **`docs/rollouts/YYYY-MM-DD-<slug>.md`** — new chronological note (summary,
   why, exact files, verification commands run, follow-ups).
3. **`PLAN.md`** — scope/approach changes.
4. **`docs/phase-7-strategy.md`** — the owning phase doc; update to match actual
   implementation state.
5. **This doc** and any other touched docs (Settings/help copy).

Do **not** open the PR as a draft (repo rule: open ready for review by default).

---

## 11. Touch-point index (implementation map)

> **Refined by [§12](#12-review-reconciliation-codex-automated-review) — read it before
> following any row below.** The one-line map cells are deliberately terse; §12 corrects
> several that would otherwise mislead (net-exposure gating, returning the
> deterministic-filtered Bull output, preserving the Bear fact-check context + candidate
> evidence, recording Red-Team rejections, passing the account-scoped policy into the
> reviewer, the JSON-helper scope, and the write-time/ops-snapshot independence gaps).

| Area | Anchor | Change |
|------|--------|--------|
| Delete in-flow Bear | `src/lib/strategy.ts:~2225-2440` | Remove `bearSystemPrompt`/`bearSchema`/`bearUserContent`/`resolveLlmEndpoint(...,"red")`/fetch/parse/`bearProposals`; return Bull output, no 2nd LLM call. |
| Single adversary call site | `src/lib/strategy.ts:444-464` | Gate on `side==="buy"\|\|"short"`; three-way verdict; on half, spread-mutate to 0.5×; on reject, `continue`; never call for sell/cover. |
| Conviction gate | `src/lib/strategy.ts:89`, `892-919` | Remove threshold; repurpose to side-only or delete. Drop `tuning.redTeamConvictionThreshold` + its UI. |
| `debateProposal` rewrite | `src/lib/red-team.ts:44-199`, `201-275` | Drop SELL/SHORT=BULL framing; state size + caps upfront; three-way verdict; remove `openAiJsonObject:true`; tolerant parse; retry/failover. Simplify/remove the now-vestigial `isBullish` param (`strategy.ts:447`): with exits exempted (§3.5) `cover` never reaches it and `short` is always the non-bullish case, so it collapses to "is this a buy." |
| Kill env override | `src/lib/red-team.ts:33-42`, `92-107`, `210` | Delete `redTeamProvider()`, `RED_TEAM_LLM_PROVIDER`/`RED_TEAM_LLM_MODEL`, Anthropic special-case, hardcoded default. |
| No-fallback independence | `src/lib/llm-provider.ts:16-19` | Blank `redTeamLlmModel` → not the Green model; unconfigured or auto-different-provider. Update `types.ts:402` comment. |
| Different-provider default + warning | `src/lib/llm-provider.ts` + `src/lib/db-api-keys.ts:448-471` | Iterate `LLM_PROVIDER_SERVICES` for a 2nd key; strong default; same-provider → Settings warning (not block). |
| Settings adversary-model field | `app/dashboard-client.tsx:4344`, `4369-4390`, `4843` | Remove "Same as Green Team" option/hint/KeyVal; add same-provider warning chip; placeholder rename. |
| Settings help copy | `app/dashboard-client.tsx:4342-4390` / `4820-4845` | Add §6 reliability guidance. |
| Fail-closed handling | `src/lib/strategy.ts:654-702` | Ensure new adversary sets `requiresHumanReview` across all 3 failure modes; add loud flag for `test/local`. |
| Persist unavailable reason | `src/lib/strategy.ts:690-698`; `src/lib/db-proposals.ts:148-158`, `256-271` | Append to `decision.reasons` before `insertProposal`. |
| Notification title | `src/lib/dashboard-ui.ts:240-266` | Stop overwriting `pending_approval` title when `payload.adversaryUnavailable`. |
| Notification payload flag | `src/lib/strategy.ts:693` | Add `adversaryUnavailable`/`adversaryUnavailableReason`; extend `asRecord` reader. |
| Pending-approval badge | `app/dashboard-client.tsx:2264-2340` (chip idiom `6668-6671`) | New amber warning chip. |
| Shared JSON helper | `src/lib/llm-call.ts:~142` | Add `extractJsonPayload`; apply at all parse sites. |
| Retry wrapper | `src/lib/llm-request.ts:55` | Add `fetchLlmWithRetry`; swap adversary `llmFetch` calls. |
| Token-cap consolidation | `src/lib/llm-request.ts:69-73` | Merge `strategyCritique`/`redTeamDebate` → one `adversaryReview` key. |
| Tests | `test/llm-provider.test.ts:67-76`, `test/red-team.test.ts:20-170`, bear-step tests | Rewrite per §10. |

---

## 12. Review reconciliation (Codex automated review)

Automated design review (Codex, 2026-07-01) raised 20 substantive points on this spec.
All are folded in below; where a point corrects §11's terse map or a detailed section,
**this section is authoritative.** Grouped by area.

### 12.1 Verdict & sizing (§3.3, §3.6)

- **R1 — `approve-at-half` that is unplaceable must NOT proceed at full size.** §3.3's
  "no-op the haircut" is corrected: when `0.5×` falls below the bracket/whole-share/floor
  minimum, the adversary only approved *lower* risk, so proceeding at the original
  deterministic size violates that verdict. **Route to human review (or reject) instead of
  silently keeping the larger trade.** Never up-size an `approve-at-half`.
- **R2 — Half-size must handle quantity-based limit orders.** When `marketableLimitEntries`
  is enabled the post-sizing enrichment converts qualifying openings to **quantity-based
  limit orders and clears `dollarAmount`** (`src/lib/strategy.ts` ~`2868-2873`), so
  `proposal.dollarAmount * 0.5` becomes `NaN` and wiping `quantity` produces an invalid
  order. Compute the haircut from the **estimated notional** (or halve `quantity` on the
  quantity-routed path) rather than assuming every finalized proposal is dollar-routed;
  if neither is placeable at half, apply R1 (route to human).
- **R3 — A "cap on openings reviewed per run" must fail closed, not skip review.** §3.6's
  optional cap is corrected: any opening beyond the cap must **route to human / fail
  closed**, never proceed unreviewed — otherwise it recreates the silent-unreviewed
  autonomous path this design eliminates. Prefer no cap (concurrency handles latency, R4).
- **R4 — Use a bounded concurrency limiter, not raw `Promise.all`.** `Promise.all` starts
  every adversary request at once. Use a real worker-pool / limiter (e.g. `p-limit`-style,
  cap 3–4) so a wide run can't burst all Red-Team calls and re-trigger the
  scheduler-lock / rate-limit starvation §3.6 is trying to avoid.

### 12.2 Side/exit scope & telemetry (§3.1, §3.5, §11)

- **R5 — Net-exposure gating belongs in the §11 map too.** §11's "gate on
  `side==="buy"||"short"`" is corrected to match §3.5: gate on **net risk direction** — a
  `buy` covering an existing short or a `short` trimming an existing long is
  risk-*reducing* and must be exempt (look up the held position as the sizer does), else
  the adversary could reject/half-size a de-risking trade.
- **R6 — Deleting the in-flow Bear must RETURN the deterministic-filtered Bull proposals.**
  `deterministicBearFilter` runs immediately before the Bear LLM; its filtered
  `bullProposals` (phantom-exit / regime / fundamentals vetoes §3.1 says MUST survive) are
  the output. The map's "return Bull output" means **return the deterministic-filtered
  output**, not the raw pre-filter proposals.
- **R7 — Preserve the Bear fact-check context when consolidating.** The in-flow Bear passes
  `candidatesUnderReview` and instructs the model to fact-check Bull claims against
  fundamentals/technicals/smart-money/macro. The consolidated Red Team prompt/input MUST
  carry the **full candidate evidence + the same fact-check instruction** — the
  deterministic pre-filter only covers a few fixed vetoes and cannot replace it.
- **R8 — Record Red-Team rejections before dropping them.** The map keeps `continue` on a
  reject, which leaves a rejected opening out of `trade_proposals` and the audit/activity
  feed — hiding the adversary's most important negative verdict from operator review and
  learning telemetry. **Insert a proposal/audit row (status `rejected`, with the Red reason
  + thesis tag) before `continue`**, matching the existing user/policy/broker-rejection paths.

### 12.3 Reliability / JSON parsing (§4.1, §4.3)

- **R9 — The JSON extractor must not be greedy.** The sketched helper grabs from the first
  `[`/`{` through the last `]`/`}`, which combines / corrupts output when prose contains a
  stray bracket or multiple JSON-looking blocks. **Strip enclosing code fences and scan for
  the first *balanced* JSON object/array**, not a greedy first-to-last slice.
- **R10 — Apply the JSON helper to the Bull/Green parser too.** §4.1's "apply everywhere an
  LLM response is parsed" must include the **Green/Bull proposal parser** (bare
  `JSON.parse(text)` at `src/lib/strategy.ts` ~`2269`); otherwise fenced JSON on the
  proposal step still degrades to zero proposals — the same reliability failure in the
  primary path.
- **R11 — Define the backup reviewer before requiring failover.** §4.3's "fail over to the
  configured backup adversary model" needs a concrete source: the spec otherwise defines
  only a single adversary model. Either (a) add an explicit **backup adversary model**
  Strategy Studio setting (surfaced, persisted — no hidden fallback, per "Settings tells the
  truth"), or (b) drop the failover step. Do not invent an implicit env/default fallback.

### 12.4 Independence enforcement (§3.8, §8, §11)

- **R12 — Compare RESOLVED models/endpoints, not raw policy strings.** Independence checks
  (migration §8 and write-time R14) must compare the **resolved** Green vs Red models: a
  blank `llmModel` resolves to `OPENAI_MODEL`/`DEFAULT_OPENAI_MODEL`, so an explicit Red
  equal to that default (e.g. `gpt-5.4-mini`) is the *same runtime model* yet passes a raw
  `redTeamLlmModel !== llmModel` check. Compare `resolveLlmEndpoint(...,"green")` vs
  `(...,"red")` (model + provider).
- **R13 — Provider auto-default needs a provider→model map.** §3.8b iterates
  `LLM_PROVIDER_SERVICES` for a second key, but that yields provider IDs/keys, not a model
  string (`resolveLlmEndpoint` picks the provider *from* the model prefix). Add an explicit
  **provider → default-model** mapping (e.g. anthropic → `claude-haiku-4-5`, gemini →
  `gemini-2.5-flash`) so a blank Red with a second-provider key resolves to a concrete model.
- **R14 — Enforce exact-model independence on WRITES, not just migration.** §8 migrates
  existing rows, but `app/api/policy/route.ts` (~`113`) only validates Red as non-empty, so
  a future PUT can still save `llmModel === redTeamLlmModel`. Add **write-time (and runtime)
  validation** (using the R12 resolved comparison) + tests, so both roles can never resolve
  to the same model.
- **R15 — Migrate the env-selected Red Team before deleting the env override.** Deployments
  running `RED_TEAM_LLM_PROVIDER=anthropic` / `RED_TEAM_LLM_MODEL` with a blank
  `policy.redTeamLlmModel` would, under the new no-blank-fallback rule, become
  unconfigured → fail-closed the moment §3.8c deletes those env reads. Add an **operator
  migration / startup seed** that writes the first-class Red Team setting from the env
  override (and clean `.env.example`) *before* removing the reads, so a working safety setup
  doesn't silently flip to human-review mode.
- **R16 — Update the ops-snapshot Red resolution.** `src/lib/ops-snapshot.ts` (~`203`)
  derives Red diagnostics via `resolveLlmEndpoint({ llmModel: policy.redTeamLlmModel }, …)`
  — treating Red as the Green model and falling back to the default when blank. After the
  no-fallback change, update this caller to resolve with `role:"red"`; otherwise live
  diagnostics report Red as "configured" while the strategy path considers it unconfigured
  and fails closed, hiding *why* runs are stuck awaiting review.

### 12.5 Account-scoped policy & visibility (§3.7, §5, §7, §11)

- **R17 — Pass the selected account policy into `debateProposal`.** The current
  `debateProposal(...userId)` shape reloads `getPolicy(userId)` (user-level), ignoring the
  selected `connectedAccountId` — so a non-default account's account-scoped Red
  model/reasoning is dropped. The consolidated call MUST pass the already-resolved
  `policy`/`connectedAccountId` in, not reload the user-level policy.
- **R18 — Surface adversary-unavailable in PROPOSE mode too.** §5/§7 add the flag only on the
  `requiresHumanReview` path, but `strategy.ts` handles `strategyAuthority==="propose"`
  *before* that check — so a manual-proposal run's adversary-unavailable trade is inserted by
  the routine pending-approval branch with no flag/reason. Set the persisted
  `adversaryUnavailable` flag + reason on **both** the propose-mode insert and the
  requiresHumanReview insert.
- **R19 — Persist a machine-readable badge flag, not just a notification payload.** The
  pending-approval card is populated from **stored pending proposals**, not notification
  payloads, so the badge needs a stable persisted field. Add a machine-readable
  `adversaryUnavailable` boolean (+ reason) to the persisted `decision` (or a dedicated
  column), and use the notification payload only for the feed/title path.

### 12.6 Handoff / process

- **R20 — PLAN.md + `docs/phase-7-strategy.md` updated**, and the rollout note now records
  the verification commands + resolved O1–O4 status (see the rollout note and the "Decisions"
  §9). This satisfies the AGENTS.md Pre-Commit / Handoff Protocol for this design change.
