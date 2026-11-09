# 2026-07-09 — Connected-accounts UI: "Currently Loaded / Other Accounts" + kill Test-Account mock-label spam

Owner-directed, display-copy + JSX only. Branch `monet/account-mgmt-ui`
(worktree `~/apps/trading-monet-acct-ui`). Two related changes shipped in one PR
because they touch the same account rows.

## Summary

**Change A — account-list restructure.** The Broker connections settings card
(`brokers.tsx`) and the top-nav Account scope sheet (`chrome.tsx`) no longer render
a flat `accounts.map(...)` with an inline "active" accent chip. Each now partitions
the same `isActive` flag into a **"Currently Loaded Account"** section (the loaded
row hoisted first, or a muted "No account loaded — select one below." note) and an
**"Other Accounts"** section. The ambiguous `active` chip is removed (the heading
conveys it); the per-row select action is relabelled **"Make active" → "Load"**
(busy text "Switching…" → "Loading…", success toast "Active account switched" /
"Scope switched" → "Account loaded"). The disconnect-confirm warning
"This is the ACTIVE account." → "This is the currently loaded account." The
row was extracted into a single `renderAccountRow` helper in each file so the
loaded and Other sections stay identical.

**Change B — stop the Test Account spamming mock wording.** "Local Mock Paper
Account" / "local mock" / "simulated" reached each Test Account row from three
stacking sources; all three are collapsed so the Test Account reads exactly like
any paper account ("PAPER · NOT real money"):
1. `TEST_ACCOUNT_LABEL` "Test Account - Local Mock Paper Account" → **"Test Account"**
   in both `src/lib/db-api-keys.ts` and `app/api/connected-accounts/route.ts`;
   the brokers.tsx add-toast fallback → "Test Account added".
2. `realityForAccount()` (`app/console/lib/derive.ts`) — the `broker === "test"`
   special case (word "TEST ACCOUNT", phrase "Local Mock Paper Account",
   "Local simulated fills…" clarification) is **deleted**; it now falls through to
   `realityForMode(environment === "paper" ? "broker/paper" : "broker/live")`. The
   `RealityInfo` union was narrowed to drop the now-unproduced "TEST ACCOUNT" /
   "Local Mock Paper Account" members.
3. The standalone "local mock" chips (chrome.tsx, brokers.tsx) are deleted, and the
   hardcoded test-only sublines collapse to the generic
   `${brokerName} · ${environment}` / `${brokerName} · paper account, not real money`
   every other account uses ("Test Account · paper").
4. The test-only subline suffix dropped the "simulated fills for learning" mock
   wording. The wash-sale-exclusion fact was **kept** (terse: "excluded from
   wash-sale accounting") because it is real — `src/lib/tax.ts:197`
   (`getUserWashSaleLockProvenance`) explicitly `.filter((a) => a.broker !== "test")`,
   so a simulated loss never locks a real account (also guarded by
   `test/washsale-test-account-excluded.test.ts`).
5. Add-Test-Account button tooltips + add-toast body rewritten to one clean mention
   ("Not loaded automatically. Load it to practice; it cannot reach real money.").
6. `src/lib/execution-mode.ts` clarification simplified to "The Test Account uses
   simulated fills and cannot reach real money." (one mention, no long label).

## Why

Owner-directed console-copy/layout fix. "An account is an account" (per repo
philosophy + memory `guardrails-nothing-hard-decision` / product-philosophy stanza):
the Test Account is just a paper account and should not be singled out with repeated
mock/local/simulated labels. The loaded-first structure answers the owner's ask that
the list clearly show which account is loaded, with "Other Accounts" you can connect
or select. **No execution logic, no account data model, no `isActive`/`isActive`
selection, and no reality-chip correctness for real broker accounts was changed** —
a live account still derives `broker/live` → "BROKERAGE" and never reads as
paper/test.

## Files

- `app/console/settings/brokers.tsx` — loaded/Other partition + `renderAccountRow`
  helper; removed `active` + "local mock" chips; "Make active" → "Load"; toast/tooltip
  copy; subline collapse; disconnect-confirm copy.
- `app/console/components/chrome.tsx` — same restructure mirrored in the Account
  scope sheet; removed `active` + "local mock" chips; "Switch" → "Load"; toast copy;
  subline collapse; added `ConnectedAccount` type import.
- `app/console/lib/derive.ts` — deleted the `broker === "test"` branch in
  `realityForAccount`; narrowed the `RealityInfo` word/phrase unions.
- `src/lib/db-api-keys.ts` — `TEST_ACCOUNT_LABEL` → "Test Account".
- `app/api/connected-accounts/route.ts` — `TEST_ACCOUNT_LABEL` → "Test Account".
- `src/lib/execution-mode.ts` — test-account clarification simplified.
- `test/connected-accounts-route.test.ts` — assertion updated to "Test Account".
- `test/persistence-notification.test.ts` — clarification assertion "local simulated
  fills" → "simulated fills".
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md` — In Progress row.

## Verification

- `npx tsc --noEmit` → exit 0.
- `npm run lint` → 0 errors (367 grandfathered warnings, none new in touched files).
- `npm test` (vitest) → after updating the two assertions above, all green
  (306 files / 3168 tests). The single initial failure was
  `persistence-notification.test.ts` asserting the old exec-mode clarification
  string — expected and corrected.
- `npm run build` → exit 0.

## Follow-ups

- Live-board effort-log row flips to Completed on PR merge; the tracked
  `docs/EFFORT-LOG.md` mirror is reconciled by the next session per convention.
- The chrome.tsx Account-scope subline for the Test Account now appends the generic
  paper clarification ("Your broker's practice sandbox…") via the "an account is an
  account" fall-through — intentional per the task; the safety signal (paper, not
  real money) is preserved.
