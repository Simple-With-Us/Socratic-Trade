# 2026-06-21 — Proposal timestamps + staleness, and command-bar status cleanup

## Summary

Three UI changes to the dashboard command bar and the Decision view, driven by
operator feedback (with an annotated screenshot):

1. **Pending proposals now show when they were proposed, plus a staleness
   warning.** Each card in "Pending approval" displays `Proposed <date, time> ·
   <relative age>` (e.g. `Proposed Jun 21, 2:34 PM · 3h ago`). Because proposals
   sit in the queue until a human approves/rejects them, an old one used to look
   just as "current" as a fresh one. The age now escalates visually:
   - `< 1h` — fresh, faint timestamp only.
   - `≥ 1h` — **Aging** (amber) chip + a caution line: "Prices and conditions may
     have changed since this was proposed — re-run the strategy before approving."
   - `≥ 24h` — **Stale** (red) chip + the same caution line.
2. **Removed the redundant "Test Mode" status line** (blue dot) from the command
   bar's brand block. The persistent tri-state execution safety banner at the very
   top of the page already states Test / Paper / Brokerage, so the third status
   line was duplicative. The brand block now shows two lines: autonomy state and
   market session.
3. **Fixed the command bar looking "too thin" / clipped.** The header was pinned
   to a fixed `h-14` (56px) with `py-0` at `xl`, which clipped the stacked status
   lines. It is now a flexible `min-h-16` with normal padding, so it never clips
   and reads as a balanced bar with the two remaining status lines.

## Why

- The operator could not tell a freshly-generated proposal from one the agent
  produced hours/days/weeks ago, since the queue persists until answered. Showing
  the proposal time + an explicit staleness state prevents acting on a stale idea.
- The brand block stacked three status dots (autonomy / market / mode) under a
  fixed-height bar; "Test Mode" duplicated the top safety banner and the third
  line overflowed the fixed height, which is what looked wrong.

## Flow button (question raised, no change made)

The operator asked what the **Flow** button is for. It opens a full-screen
"Strategy Flow — Pipeline & node visualizer" modal (`app/ui/strategy-flow.tsx`,
React Flow / `@xyflow/react`). It is a **static, illustrative** diagram of the
data → vector-DB → agents → execution pipeline with **hardcoded** placeholder
nodes (SEC Filings, Yahoo News, FRED Macro → Pinecone → Evaluator/Trader agents).
It is read-only (pan/zoom only), is not data-driven, and does not drive any
behavior. Left in place pending a product decision on its final purpose.

## Files

- `app/ui/dashboard/utils.tsx` — added `proposalAge()` + `relativeAge()` helpers
  and `PROPOSAL_STALE_AFTER_MS` / `PROPOSAL_VERY_STALE_AFTER_MS` thresholds.
- `app/ui/dashboard/views.tsx` — render the timestamp + staleness block in the
  pending-approval cards; import `Clock` icon and `proposalAge`.
- `app/dashboard-client.tsx` — removed the "Test Mode" status line, removed the
  now-dead `executionTone()` helper, and changed the header sizing classes
  (`min-h-14 … xl:h-14 … xl:py-0` → `min-h-16 … xl:min-h-16`).

## Verification

- `npx tsc --noEmit` — clean (after a fresh `npm install` in this container).
- `npm test` — 40 files, 307 tests passing.
- `npm run build` — green.

## Follow-ups

- Flow button: awaiting a product decision on whether to make it data-driven,
  repurpose it, or remove it.

---

# Part 2 — Proposal expiry policy + on-run LLM re-validation (backend)

## Summary

Follow-on to the staleness UI above: the operator asked for (1) a real expiry
**policy**, and (2) a supplemental task on each run that asks the LLM whether
each old, still-pending proposal *still stands*.

1. **Deterministic hard expiry** (`policy.proposalExpiryMinutes`, default **2880**
   = 2 days; 0 = Never). Any pending proposal older than the TTL is moved to status
   `expired`, with an audit event + a `proposal_withdrawn` notification + an SSE
   `proposal` event so open dashboards refresh. Runs at the **start of every
   strategy run** AND on **every scheduler tick** (even while halted / market
   closed), so the queue self-clears regardless of run cadence. Exposed as a
   **dropdown** (3h / 6h / 12h / 1d / 2d / 5d / 10d / Never).
2. **On-run LLM re-validation, cadence-gated to market hours**
   (`policy.proposalRevalidateCadenceHours`, default **0** = every run). It is **not
   optional** (no on/off switch) — it rides on strategy runs and is a supplemental
   step inside `runStrategyOnce`. Each still-pending proposal that is **due** — i.e.
   ≥ cadence hours since it was created or last re-checked (0 = always) — is sent to
   the LLM in one batched call against the fresh scan + current regime. It runs
   **only during the regular US session** (`currentMarketSession === "regular"`), so
   it **never re-checks overnight** when nothing can be acted on. Verdict per
   proposal: `reaffirm` → stamped `last_revalidated_at` + note (UI shows "Re-checked
   X ago — still advised", and the staleness clock resets); `withdraw` → status
   `withdrawn` + notification + SSE. Missing/unknown/garbled output defaults to
   *keep* (never silently drops an idea). Skips (deterministic expiry still applies)
   when the market is closed, `OPENAI_API_KEY` is absent, or the call fails. Exposed
   as a **dropdown** (Every run / Once per day / Every 5 days). The run summary gains
   "Expired N stale… Re-checked N pending: kept X, withdrew Y."

## Why

Proposals persist in the approval queue until a human acts, so an old one looks
as current as a fresh one. Expiry is the deterministic backstop; the LLM re-check
is the intelligent path that either refreshes the idea or pulls it when the setup
no longer holds — exactly "ask the LLM if each old not-yet-approved/rejected
proposal still stands."

## Files

- `src/lib/proposal-revalidation.ts` — **new**: `expireStalePendingProposals`,
  `revalidatePendingProposals`, and the pure, tested `decideRevalidationActions`.
- `src/lib/types.ts` — `TradingPolicy` (+3 fields), `PendingProposal`
  (`lastRevalidatedAt`/`revalidationNote`), `NotificationEventType`
  (+`proposal_withdrawn`).
- `src/lib/defaults.ts` — `DEFAULT_POLICY` defaults + enable `proposal_withdrawn`
  notifications.
- `src/lib/db.ts` — migration for `last_revalidated_at`/`revalidation_note`,
  surfaced in `listPendingProposals`, new `markProposalRevalidated`.
- `src/lib/llm-request.ts` — `proposalRevalidation` token cap.
- `src/lib/strategy.ts` — run-loop integration + summary lines.
- `src/lib/scheduler.ts` — per-tick deterministic expiry sweep.
- `src/lib/dashboard-ui.ts` — notification display title for the new type.
- `app/api/policy/route.ts` — validation for the new knobs; `isNotificationEvent`
  now includes `price_alert` (pre-existing gap) + `proposal_withdrawn`.
- `app/ui/dashboard/settings.tsx` — expiry/re-check knobs + notification toggle.
- `app/ui/dashboard/views.tsx` — pending card shows "Re-checked … still advised".
- `test/proposal-revalidation.test.ts` — **new**, 6 tests.

## Verification

- `npx tsc --noEmit` — clean.
- `npm test` — 41 files, **313 tests** passing (+6).
- `npm run build` — green.

## Review hardening (multi-agent self-review)

A parallel code-review + integration audit surfaced several issues, fixed here:

- **TOCTOU bug (real):** `executeProposal` checked `status === "proposed"` up front,
  then awaited scan/broker review before placing the order. Deterministic expiry
  (scheduler tick) or a concurrent run's re-validation could retire the proposal
  in that window, so an order could be placed for an idea the system already
  pulled. Added a re-assert of `status === "proposed"` immediately before acting;
  if it's no longer pending, the approval aborts with a clear reason.
- **New statuses surfaced consistently:** `statusTone` and the Activity-feed accent
  border now map `expired`/`withdrawn` to the "down" tone (were falling through to
  neutral). Added a Discord formatter case for the `proposal_withdrawn` event
  (amber, with symbol/side/outcome/reason) — it previously fell through to the
  default dark-red with no fields.
- **Prompt robustness:** the re-validation prompt now tells the model that a
  proposal with no `currentMarketData` (symbol fell out of today's scan) is
  insufficient evidence to withdraw — reaffirm it.

## Follow-ups

- Thresholds are policy-configurable; the per-run re-check is one batched LLM
  call. If queues grow large, consider chunking the re-check or capping how many
  proposals are re-validated per run.
- `expired`/`withdrawn` are distinct statuses (vs `rejected`) so a future
  Activity/Runs filter could surface them separately.
- **Investigated, no action needed:** a scout agent suspected `getFallbackMetrics`
  / `MOCK_METRICS` in `src/lib/data-providers.ts` might fabricate user-facing
  numbers (a CLAUDE.md "never fabricate" violation). Confirmed it is **test-only**:
  `mockEnrichmentProvider` and its `noopProvider`/`fallbackProvider` aliases are
  referenced only inside `data-providers.ts` and `test/`, and are NOT part of the
  live `CascadingEnrichmentProvider`, so no fabricated value reaches the dashboard.
  Minor cleanup left for a separate PR: `fallbackProvider` is an unused export
  (tests use `noopProvider`).
