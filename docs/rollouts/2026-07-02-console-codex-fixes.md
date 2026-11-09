# 2026-07-02 — /console: address 13 Codex review findings

## Summary

Fixed all 13 findings from the Codex code review of the new `/console` UI
(PR #317, `app/console/**`). Two findings required a small server-side
addition (surfacing `connected_account_id` on notification events); everything
else is client-side. Added a unit test for the loosening classifier.

## Base / branch

Branch `claude/console-codex-fixes`. PR #317 had not merged to `main` within
the polling window when this work was committed (all three checks — verify,
smoke, gitleaks — were green on its head `fb51554` at 05:34Z, but the PR sat
un-merged with no auto-merge armed), so per instruction this branch is cut
from `origin/claude/console-ground-up-ui` at `fb51554` — which already has
`origin/main` (`e714852`) merged in, so it is content-equivalent to
post-merge main and will land cleanly on top of the #317 squash.

## Findings and dispositions

1. **Per-account reality mislabeled when active account is Test**
   (`app/console/lib/derive.ts`): `realityForAccount` consulted
   `policy.paperMode`, which the server derives for the ACTIVE account only
   (`getPolicy` sets `paperMode = broker === "test"`). With the simulator
   active, every broker/live row in the account switcher and connections list
   read "TEST · practice money" — erasing the real-money warning exactly where
   a switch decision is made. Now derived purely from the account row's own
   `broker`/`environment`; for the active account this matches `deriveReality`
   because `paperMode ⇔ broker === "test"`.

2. **extraPatch changes bypassed the LIVE typed-confirm** —
   universe (`includedIndices`, `additionalSymbols`), `blocklist`,
   `permittedOrderTypes`, and `sellToFundBuy` travel via `extraPatch`
   (replace-whole-value), so `PolicySaveBar` never classified them and a
   loosening (broadening universe, un-blocking a symbol, enabling more order
   types, escalating sell-to-fund-buy) committed on LIVE without CONFIRM.
   Added `classifyExtraPatch` (pure, in `app/console/lib/policy-diff.ts`):
   adds→looser for allow-lists, removals→looser for the blocklist,
   rank-escalation→looser for sellToFundBuy. The review sheet now shows these
   entries with LOOSER/TIGHTER tags and they arm the typed confirmation.

3. **`volPanicBrakeEnabled` loosening direction inverted** — was
   `looserWhen:"on"`; disabling the panic brake is the loosening. Added an
   `"off"` variant to `looserWhen` and set the brake to it.

4. **`brokerBracketsEnabled` inverted the same way** — turning broker-held
   brackets OFF removes protection; now `looserWhen:"off"`.

5. **Short positions labeled with the long stop** — `deriveProtection` now
   mirrors the server (`generateProactiveRiskProposals`): shorts use
   `riskRules.shortStopLossPct`, falling back to `stopLossPct`; trailing stops
   apply to shorts as the synthetic-stop monitor does. Also surfaces the
   honest gap: with `shortSellingEnabled` off, the app's stop monitor SKIPS
   short positions entirely (both the trailing monitor and proactive exits
   guard on it), so such a short shows no app protection rather than a false
   stop label.

6. **Preset Apply used `/api/profiles/[id]/activate`** — now prefers
   `POST /api/profiles/[id]/copy` with the active `connectedAccountId`
   (`applyProfileToAccount`: writes only that account's live row, preserves
   its run-state, leaves the library active flag alone). `activate` remains
   only as the fallback when NO connected account exists (fresh local
   install), with an honest toast for that path. The "applied here" chip now
   keys off `policy.activeProfileId` (what THIS account runs) rather than the
   library flag.

7. **Account tax type silently overridden** — the dashboard tax summary reads
   `activeAccount.taxationType ?? policy.taxSettings.taxationType`, and no
   PATCH endpoint exists for a connected account's `taxationType`
   (`/api/connected-accounts/[id]` is DELETE-only; the POST upsert is a
   credential-shaped connect flow, unsafe to reuse as a field editor). When
   the connected account defines `taxationType`, the Settings card now shows
   it read-only with honest copy; the editable select remains for accounts
   (or the simulator) that don't define it.

8. **notificationSettings mis-scoped in Settings** — it is a USER-level policy
   field (`USER_LEVEL_POLICY_FIELDS` in `src/lib/db-profiles.ts`, overlaid on
   every account at read time). Moved the Event-notifications card under ALL
   YOUR ACCOUNTS with corrected copy (one list + webhook for the whole login);
   the delivery-channels line no longer says "on this account".

9. **"Clear = off" was dishonest for defaulted fields** — verified server
   behavior: the PUT strips `null`s (`stripNullsDeep`) and `mergePolicy`
   re-applies `DEFAULT_POLICY` on every read, so clearing e.g. stop-loss
   reverts to the shipped 8%, not "off". Rather than disabling clearing, the
   UI now tells the truth per field via `clearedFallback`: placeholders read
   `default 8` instead of `off`, the review sheet renders blank as
   `default (8%)`, and `classify` compares against the post-clear EFFECTIVE
   value (clearing 5%→default 8% is LOOSER; 20%→8% is TIGHTER; clearing a
   no-default cap is the loosest move; introducing a guard is tightening —
   this also fixed clearing a `looserWhen:"down"` floor being misclassified
   as "tighter"). `buildPatch` additionally seeds nested parents from the
   current policy so a sparse `universeFloor` edit no longer wipes the
   sibling floors (the API replaces `universeFloor` wholesale, unlike
   `riskRules`, which it deep-merges).

10. **Toasts rendered outside `.console-root`** — `ToastProvider` sat above
    `ShellFrame`, so `.con-toasts` mounted outside the token scope and
    rendered unstyled. The provider now lives inside the `console-root`
    element (it adds no DOM around its children; the fixed-position viewport
    is unaffected by the flex column).

11. **User-wide kill_switch events implied active-account scope** —
    notification rows persist `connected_account_id` but
    `listNotificationEvents` didn't select it. Surfaced it
    (`NotificationEvent.connectedAccountId`, optional — src/lib change), and
    `deriveAttention` now labels a breaker event from another account with
    that account's name, and marks untagged legacy events as possibly
    belonging to any account (only when several exist).

12. **Any stop order counted as protection** — `hasWorkingStop` ignored
    `side`, so a stop-limit ENTRY on the same symbol read as protection. Now
    `hasWorkingClosingStop`: longs need a `sell` stop; shorts a `cover` (or
    `buy`, since broker listings vary) stop.

13. **Numeric inputs collapsed "0." while typing** — `PolicyFieldRow` stored
    `Number(raw)` back into the controlled value. It now keeps the raw string
    while the input is focused (committing the parsed number to the draft on
    each keystroke) and snaps back to canonical on blur. NaN intermediates
    are stored as null instead of NaN.

## Structure changes

- New `app/console/lib/policy-diff.ts`: pure diff/classification logic
  (`classify`, `computeDiff`, `buildPatch`, `classifyExtraPatch`,
  `clearedFallback`) extracted from `policy-form.tsx` so the safety
  classification is unit-testable. `policy-form.tsx` re-exports the old names.
- New `app/console/guardrails/field-defs.ts`: the FieldDef arrays moved out of
  the page component (pure data, importable by tests).
- New `test/console-policy-diff.test.ts`: 12 tests covering findings 2/3/4/9,
  asserting against the REAL guardrails field defs (not copies).

## Files

- app/console/lib/policy-diff.ts (new)
- app/console/guardrails/field-defs.ts (new)
- app/console/components/policy-form.tsx
- app/console/guardrails/page.tsx
- app/console/lib/derive.ts
- app/console/lib/api.ts
- app/console/components/shell.tsx
- app/console/components/chrome.tsx
- app/console/strategy/page.tsx
- app/console/settings/page.tsx
- src/lib/types.ts (NotificationEvent.connectedAccountId, optional)
- src/lib/db-notifications.ts (select + map connected_account_id)
- test/console-policy-diff.test.ts (new)
- STATUS.md, docs/rollouts/2026-07-02-console-codex-fixes.md (this note)

## Verification

```
npx tsc --noEmit        # clean
npm run lint            # 0 errors (280 pre-existing grandfathered warnings)
npm test                # all files pass, incl. new console-policy-diff (12 tests)
npm run build           # green; all 7 /console routes prerendered
```

## Follow-ups / known limits

- `buildPatch` seeds nested parents from the client snapshot; a concurrent
  edit to a sibling `universeFloor`/`riskRules` key from another session can
  be overwritten (last-write-wins) — same class of race the whole-array
  fields already had.
- The same "0."-collapse pattern still exists in the Strategy page weight
  inputs and Settings tax-rate inputs (outside the reviewed finding's scope).
- `allowExtendedHoursSyntheticStops` keeps `looserWhen:"on"`; whether
  extending app-stop coverage into thin extended-hours tape is looser or
  tighter is arguable and was not part of the review findings.
- A future connected-account PATCH endpoint would let the console edit
  `taxationType` instead of showing it read-only (finding 7).
