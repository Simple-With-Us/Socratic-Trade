# 2026-07-03 — Console small fixes (t7 / t18 / t22 / t39)

Branch: `claude/console-small-fixes`
Worktree: `~/apps/trading-wt-console-small` (isolated, off `origin/main` @ `eae514be`)
Status: **pushed, no PR opened, landing deferred** (see Follow-ups).

## Summary

Four small, independently-verified-open tasks bundled onto one branch per the operator's
request. No design-doc or roadmap changes; all four are localized hardening/consistency fixes.

### t7 — Reusable raw-numeric-input component (fixes the "0."-collapse bug)

`PolicyFieldRow` (`app/console/components/policy-form.tsx`) already had a workaround for a bug
where a plain `value={String(current)}` numeric `<input>` re-renders `"0."` back to `"0"` (or
`"12."` back to `"12"`) on every keystroke, because `Number("0.")` parses to a whole number —
so a trailing decimal point, or a bare `-`, can never actually be typed. The workaround: keep the
raw typed text in local state while the input is focused, commit the *parsed* number to the
caller on every keystroke, and drop back to the canonical display string on blur.

That pattern existed in exactly one place. Three other numeric inputs elsewhere in the console
had the plain (buggy) `value={String(x)}` + `Number(e.target.value)` form and would exhibit the
same collapse. Extracted the pattern into a new `RawNumInput` component
(`app/console/ui/primitives.tsx`, next to `NumInput` which it wraps) with props `value` (canonical
display string), `onValueChange(parsed, raw)` (called every keystroke), and `emptyValue` (what to
report when the field is empty/unparsable — caller-defined, matching each site's prior fallback
semantics). Applied at:

- `app/console/strategy/page.tsx` — the eight scoring-weight inputs; `emptyValue` is
  `DEFAULT_WEIGHTS[key]` (unchanged from the prior `e.target.value === "" ? DEFAULT_WEIGHTS[key] :
  Number(...)` behavior).
- `app/console/settings/page.tsx` — `shortTermRatePct` / `longTermRatePct` (tax rates) and
  `marketScanCandidateLimit` / `marketScanOutlierReserve` (scan shape); `emptyValue: 0` in all four
  cases, matching the prior `Number(e.target.value)` behavior where `Number("")` is `0`.

`PolicyFieldRow` itself was **not** refactored to use the new component — it has extra behavior
(blank-vs-null semantics via `draft.set(path, null)` for the "clear to default" case, plus a
placeholder derived from `clearedFallback`) that doesn't map cleanly onto `RawNumInput`'s simpler
contract, and touching it wasn't necessary to close the four still-buggy sites named in the task.
It remains the one hand-rolled instance; a future pass could still fold it in if the two contracts
are reconciled.

### t18 — De-fragilize the market-regime label contract

`determineMarketRegime` (`src/lib/macro.ts`) returned a bare `string`, and its six exact label
values are persisted verbatim into `TradeProposal.entryMarketRegime` and then joined on by exact
string equality in three other places. Nothing enforced that the label set was closed or
documented that renaming one breaks historical joins.

- Added `export const MARKET_REGIME_LABELS` (stable id -> exact label, `as const`) with a doc
  comment explaining the persisted-contract hazard and naming the three join sites.
- `determineMarketRegime`'s return type is now `MarketRegimeLabel = (typeof
  MARKET_REGIME_LABELS)[keyof typeof MARKET_REGIME_LABELS]`, and its body now returns
  `MARKET_REGIME_LABELS.crisis` etc. instead of literal strings — **no string values changed**
  (verified via `test/macro.test.ts`'s pre-existing assertions, which all still pass unmodified).
- Added traceability comments (not code changes — see below) at the three exact-equality join
  sites: `src/lib/strategy.ts`'s `selectThesisStat` (`s.regime === proposal.entryMarketRegime`),
  `src/lib/performance.ts`'s `getFactorScorecard` (`lot.regime?.trim() ===
  options.regime?.trim()`), and `app/console/macro/page.tsx`'s `RegimeCard`
  (`r.regime === board.regime`). None of the three hardcode a literal regime string — they all
  compare two dynamically-sourced `string`-typed fields — so there was no literal to swap for the
  const at the comparison itself; the fix is documentation that points back to
  `MARKET_REGIME_LABELS` so a future edit doesn't casually "fix" one side of a comparison without
  realizing it's a persisted-data join.
- Added a new `describe("determineMarketRegime — regime label set is a persisted contract", ...)`
  block to `test/macro.test.ts` driving all six branches (`vix > 30`; `vix > 20`; `inverted && vix
  > 17`; `vix < 13 && !inverted`; neutral; inverted-calm; `asOf === "unavailable"`) with `toBe()`
  exact-string assertions against both `MARKET_REGIME_LABELS.*` and the literal string, plus a
  comment explaining why a rename needs a migration/alias map.

### t22 — Account-deletion loss preview: pending learned-context items

`getAccountDeletionCounts` (`src/lib/account-deletion.ts`) already counts
`learned_context_pending` (it's in `DELETE_TABLES_BY_USER_ID`), so `preview.counts` already carried
the number — it just wasn't surfaced. Added a conditional warning line in the scope-preview block
of `app/console/settings/danger.tsx` (after the `isLocalOperatorAccount` note): when
`preview.counts.learned_context_pending > 0`, shows "N pending learned-context item(s) awaiting
your approval will be discarded" with a link to `/console/approvals`. No API/interface change.

Added a `learned_context_pending` row seed plus a
`deletion.getAccountDeletionPreview(...).counts.learned_context_pending` assertion (before delete)
and a post-delete row-count-zero assertion to the existing multi-assertion test in
`test/account-deletion.test.ts` (the "requires preparation and deletes only the signed-in user's
private app data" test, which already seeded a `learned_context` row in the same spot).

### t39 — `notify.bridge.error` ops-feed formatter

`src/lib/dashboard-feed.ts`'s `formatAuditEvent` had humanized one-liners for
`web_source_refresh` and `congress_share_daily` ops/housekeeping audit kinds, but
`notify.bridge.error` (a notification-delivery failure) fell through to the generic
`serializeAuditPayload`/`genericAuditDetail` fallback and rendered as raw-ish JSON in the
Activity feed. Added a branch (right after the `congress_share_daily` block) returning title
"Notification delivery failed" and detail `Could not deliver <type> notification · <error
message>` via the existing `joinDetail`/`stringValue` helpers, with `fullText:
serializeAuditPayload(payload)` so the raw JSON stays available behind the existing toggle —
mirrors the `web_source_refresh` pattern exactly. Added a case to `test/dashboard-feed.test.ts`
asserting the humanized one-liner and that `fullText` still contains the raw error string.

Note: this formatter is purely additive (a new `if (kind === ...)` branch); I did not verify how
often `notify.bridge.error` actually fires in production — that's a pre-existing audit-event kind
this pass did not investigate further.

## Why

All four were flagged as small, independently verified-open items (no dependency on the
in-flight holiday-time-dependence fix or any other agent's active work) and batched onto one
branch per the operator's request, to avoid four separate worktrees/branches for changes this
size.

## Files

- `app/console/ui/primitives.tsx` — new `RawNumInput` component (+ `useState` import).
- `app/console/strategy/page.tsx` — scoring-weight inputs now use `RawNumInput`.
- `app/console/settings/page.tsx` — tax-rate + scan-shape inputs now use `RawNumInput`.
- `src/lib/macro.ts` — `MARKET_REGIME_LABELS` const, `MarketRegimeLabel` type,
  `determineMarketRegime` return type + body updated to use the const.
- `src/lib/strategy.ts` — traceability comment at `selectThesisStat`'s regime join.
- `src/lib/performance.ts` — traceability comment at `getFactorScorecard`'s regime join.
- `app/console/macro/page.tsx` — traceability comment at `RegimeCard`'s regime join.
- `test/macro.test.ts` — new persisted-contract describe block (6 assertions + a const-value
  cross-check per branch).
- `app/console/settings/danger.tsx` — pending learned-context warning line item + `next/link`
  import.
- `test/account-deletion.test.ts` — preview-count assertion + post-delete row-count assertion for
  `learned_context_pending`.
- `src/lib/dashboard-feed.ts` — `notify.bridge.error` formatter branch.
- `test/dashboard-feed.test.ts` — new test case for the `notify.bridge.error` branch.
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md` — this rollout's entries.

## Verification

Run from `~/apps/trading-wt-console-small` (`NODE_AUTH_TOKEN=$(gh auth token) npm ci` done first):

- `npm run lint` — **0 errors**, 295 warnings (pre-existing grandfathered baseline, unchanged).
- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run test/macro.test.ts test/dashboard-feed.test.ts test/account-deletion.test.ts test/account-deletion-coverage.test.ts test/account-delete-cleanup.test.ts` —
  **54/54 passed**.
- `npx vitest run test/console-drilldown.test.ts test/console-policy-diff.test.ts` (other console
  unit tests in the repo, for a broader regression check since two `app/console/*` pages were
  touched) — **50/50 passed**.
- `npm test` (full suite) — **2356 passed / 17 failed**, across exactly 8 files:
  `test/strategy-llm-failover.test.ts`, `test/strategy-bear-fail-closed.test.ts`,
  `test/strategy-moneypath-drawdown-flip.test.ts`, `test/strategy-money-path-f-g.test.ts`,
  `test/strategy-rationale-collapse-gate.test.ts`, `test/redteam-observability-g10.test.ts`,
  `test/strategy-bull-truncation.test.ts`, `test/persistence-notification.test.ts`. These are the
  pre-existing holiday-time-dependence failures another agent is fixing — confirmed to be exactly
  this list and nothing else. No `data/app.db` artifact was present in the worktree, so the
  "delete gitignored db" fallback wasn't needed.
- `npm run build` — green, no errors (checked full output for `error`/`fail` tokens after the
  normal build summary; none found beyond the expected "Failed to compile: 0" style non-matches).

## Follow-ups

- **Landing is deferred.** Per instructions, this branch was pushed but no PR was opened and
  `land.sh` was not run. `docs/EFFORT-LOG.md`'s "In Progress" section notes the branch and that
  landing waits on the holiday-time-dependence test fix merging first, since `land.sh`'s local
  verify gate (`tsc` -> `test` -> `build`) would otherwise fail on the 8 unrelated pre-existing
  failures above until that fix lands on `main`.
- `PolicyFieldRow` still hand-rolls the raw-while-focused pattern rather than using the new
  `RawNumInput` — intentionally out of scope for this pass (see t7 notes above); worth reconciling
  later if the two components' blank/null semantics can be unified.
- `notify.bridge.error` event frequency in production is unverified — this pass only added the
  formatter, it did not investigate how often the kind fires or whether the underlying delivery
  failures need separate attention.
