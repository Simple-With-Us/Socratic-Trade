# 2026-08-21 — Web adopts iOS's Title Case, because iOS was the compliant side

## Context & Objective
The web half of the iOS↔web parity work (owner-directed 2026-08-20: *"be wise about which text or variations to adopt and don't assume one is always superior to the other currently."*).

Of 21 audited divergences, **four were cases where iOS was correct and web had drifted.**  `docs/FLEET-UI-COPY.md`'s Title Case section names **"Run Once", "Price Alerts", "Current Policy", "Needs Attention"** and **"Win Rate"** as literal examples — and every one of those is the iOS spelling.  This change fixes web to match iOS, not the other way round.

The iOS half landed as #2974.

## Changes Made
67 strings across 10 files, grouped by rule:

- **Buttons → Title Case.**  "Run once" → "Run Once" (the fleet doc's own example), plus the six user-visible prose references to it that would otherwise disagree with the button.  "Wind down…" → "Wind Down…".
- **Card and section headings → Title Case.**  "Price alerts", "Signal health", "Recent finished orders", "Open orders (n)", "Lookahead audit", "Red Team veto efficacy", "Wash-sale lockouts", and siblings.
- **Stat-tile labels → Title Case.**  "Buying power", "Win rate", "Open market value", "Daily notional", "Short-term realized", and siblings.  A stat tile's label is a heading; its number is the value.

## The distinction that mattered most
**Run STATE words are values and stay sentence case on both platforms.**  "Winding down", "Exit-only", "Paused · market closed" were deliberately untouched — `derive.ts`'s `RunStateWord` union is unchanged, and `grep '"Winding Down"'` returns **zero** in `chrome.tsx`.

Getting this backwards — Title-Casing the state word because the button next to it is Title Case — is the one change here that would have done real damage, since `MobileModels.swift:199` and `derive.ts:179` already agree on the sentence-case form.

## One judgment call, reversed on review
The implementer Title-Cased `confirmLabel="Wind down — this sells"` into `"Wind Down — This Sells"` for consistency with the sibling button, but flagged real doubt: the appended clause is a **warning phrase**, not part of the control's name, and capitalising it reads like two proper nouns rather than a caveat.

That reservation was correct and the change was reverted to **"Wind Down — this sells"** — Title Case on the control name, sentence case on the warning.  The Title Case rule governs what the control is *called*, not everything printed on it.

## Deliberately left alone
Two "Run once" sites stay sentence case: `derive.ts`'s checklist step `"Run once → review Proposals"` and `command-palette.tsx`'s `"Run once strategy"`.  Every *other* entry in both of those arrays is a sentence-case action phrase ("Configure universe / index", "Toggle theme", "Add API key").  Title-Casing only the "Run once" entry would have made it inconsistent with its own siblings — a smaller but uglier inconsistency than the one being fixed.

Consistency *within* a surface can outrank consistency *across* surfaces.  That is the same reasoning that produced six "keep both" verdicts in the iOS audit.

Also verified and **not** changed: "Unrealized P&L" was listed as web drift in the audit, but every instance on web was already correctly Title-Cased.

## Conflict resolved by hand
`app/console/results/page.tsx` conflicted with #2971 (copy rules), which landed first.  Both sides were wanted: **ours** carried the NBSP sentence gaps, **theirs** carried the Title Case labels — taking either side wholesale would have silently dropped one of the two fixes.

Resolved by keeping ours and applying only the casing change from theirs.  Verified after: 39 NBSP bytes still in that file, "Win Rate" and "Avg Return / Closed Capital" present, zero conflict markers.

## Verification State
Full gate results recorded in the PR.  Sentence-gap lint still reports the known peer-locked backlog only (46: chrome.tsx 29, guardrails 16, admin 1), with compact-money 0 and Central-time 0 — this change did not reintroduce any gap.

## Next Steps
Blocked on peer #2794: `HomeView:893-894` still renders `LabeledContent("Max Order")` / `("Daily Cap")`, the third site of the labels #2974 renamed on the other two screens.
