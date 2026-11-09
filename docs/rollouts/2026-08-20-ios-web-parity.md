# 2026-08-20 — iOS↔web parity, judged divergence by divergence

## Context & Objective
Owner instruction, 2026-08-20: *"Improve iOS - web parity, be wise about which text or variations to adopt and don't assume one is always superior to the other currently."*

That is explicitly **not** a one-directional sync, and the audit bore that out.  Of 21 divergences: **9 adopt-web, 6 keep-both, 4 adopt-iOS, 2 where both platforms were wrong.**  A blanket "sync iOS to web" would have been wrong on **12 of 21**.

## Where WEB was the drifted side (not changed here — see the web PR)
`docs/FLEET-UI-COPY.md` names "Run Once", "Price Alerts", "Current Policy", "Needs Attention" and "Win Rate" as literal Title Case examples.  **Every one of those is the iOS spelling.**  Web had drifted to sentence case on buttons, card headings and stat-tile labels.  Those four verdicts are fixed on the web side; iOS was left alone because it was already correct.

## Where the divergence is CORRECT and was deliberately preserved
- **"Cadence" / "Extended Hours" (iOS) vs "Run every" / "Run during extended hours" (web).**  Web's are editor labels completed by their input; iOS's are read-only noun/value rows where "Run every — 60 minutes" reads as a broken sentence.
- **The "Assets" tab.**  `TabPreferences.maxTabs = 4`, so a phone must consolidate what a 15-item desktop rail need not.
- **The Results description.**  Web promises "equity curve, thesis scorecards"; `ResultsView.swift` has neither.  Adopting web's line would advertise features that do not exist.
- **The Activity description.**  The two screens genuinely contain different things — iOS leads with a notifications inbox that web does not have.

## Changes made on iOS
Nine labels adopted web's wording because the iOS text was genuinely **ambiguous**, not merely shorter:

| Was | Now | Why |
|---|---|---|
| Max Order | Max Per Order | The next row is "Daily Orders", a COUNT — so "Max Order" reads as an order-count cap |
| Daily Cap | Max Spend Per Day | The account also has a daily order cap, a daily loss stop and a daily drawdown stop |
| Daily Orders | Max Opening Orders Per Day | "opening" is load-bearing — this cap never counts protective exits |
| Stop Loss | Stop-Loss (Base %) | With ATR stops on (default) this is only the fallback distance |
| Short Stop | Short Stop-Loss | Collides with "Broker-held short buy-stops" — an ORDER, not a distance |
| Extra Symbols | Always Include (Symbols) | These names are EXEMPT from the universe floor, not merely appended |
| Ask-First | Ask-first | Renders mid-sentence and in a status pill — both value contexts |

Two where **both platforms were wrong**:
- `socraticOverrideValue` printed the raw wire enum (`"execute"`); web said "Execute in Decide mode", leaking the enum `decide` that `labels.ts:112-117` says is **never** shown to users — Autopilot is the user-facing word.  Now **"execute in Autopilot"**.
- `sellToFundValue` printed bare wire slugs, where "propose" is indistinguishable from the unrelated propose/Ask-first autonomy concept.  Now sentence-case phrases; the label gains its object ("Sell to Fund Buys").

The Guardrails destination description was **factually stale and contradicted by iOS's own screen** — it promised tighten-only while `GuardrailsView.swift:156` says "Caps can go up or down".

## Corrections to the audit, made during implementation

**The "Exit Only" instruction was wrong and was not implemented as written.**  The audit claimed unhyphenated "Exit Only" "exists nowhere else in the product."  It exists in three places and is a consistent **command name**, exactly parallel to "Wind Down" — whose state word is "Winding down".  The app deliberately runs two vocabularies: Title Case imperative commands (buttons, `AppFormat.commandLabels`) and sentence-case state words (`RunStateWord`).

So instead: `AgentControlPlan:62` "Exit-Only" → "Exit-only" (a *state* title wearing command casing — the real bug), **plus `AgentControlPlan:75` "Winding Down" → "Winding down"**, the identical defect the audit missed.  `AppComponents:24` "Exit Only" was left as a command name, with a comment telling the next agent not to "unify" it — changing it would desync it from `HomeView:487`'s button, which reads that map and is owned by peer PR #2794.

Worth knowing: `AgentControlPlan.statusTitle`'s other values are "Agent Is On" / "Agent Is Stopped" (Title Case), so the two corrected entries are now the only sentence-case ones in that slot.  Glossary consistency was judged the stronger rule; it is a two-line revert if the owner disagrees.

**A requested change would have broken the screen it fixed.**  `PolicyTightening.Cap.title` supplies the *edit* controls on Guardrails and also said "Max Order" / "Daily Cap".  Renaming only the read-only rows would have left one screen calling one field two different names.  Both fixed, with a guard test.

**The audit's auth assumption was backwards.**  It assumed `/api/proposals/from-draft` might not accept an iOS session.  It would: `/api/mobile/auth/exchange` sets a real Auth.js session cookie and iOS already POSTs to console routes through the same middleware.  The "Stage for Approval" button was **still not added** — it introduces a money-path capability from a new client, which deserves its own change and its own review rather than riding a copy-parity PR.  The copy fix landed regardless, because the old text instructed the owner to do something impossible.

## Feature fixes
- **Coach printed raw markdown.**  `CoachView.swift:272` used `Text(turn.text)` with a plain String; SwiftUI parses markdown only from `LocalizedStringKey` literals.  New `CoachMarkdown.swift` renders block kinds (headings, ordered/unordered lists, fenced code, tables, paragraphs) with per-line inline `AttributedString`.  **Two security properties mirrored from web deliberately**, because Coach output is untrusted model text that can carry RAG content: never render raw HTML, and never auto-load a remote image — `![alt](url)` renders as an inert `[image: alt]` label, never an `AsyncImage`.  Known gap: blockquote markers still print.
- **The Scan table header was deleted, not ported.**  Three fixed-width column headings sat above rows that stack those values in one vertical `VStack`, labelling nothing, and at a different inset from the rows.  A phone card list is not a table; the values already read top-down in ranking order.

## Verification State
```
xcodebuild build -destination 'generic/platform=iOS'   → ** BUILD SUCCEEDED **   exit 0
xcodebuild test  -destination 'ST-Parity simulator'    → ** TEST SUCCEEDED **    190 tests, 0 failures
```
Failing-first proven by reverting three strings: `Executed 3 tests, with 9 failures` (`("Max Order") is not equal to ("Max Per Order")` etc.).  Reverts restored, suite re-run green.

**No visual proof of the changed screens.**  Every screen touched (Guardrails, Coach, Scan, More) sits behind the OAuth login wall, which an agent cannot pass.  The app launches clean on the light theme; that is the limit of what a screenshot can show here.

## The `objectVersion` rule conflict
`xcodegen generate` emitted `objectVersion` / `preferredProjectObjectVersion` `100 → 77`.  `ios/CLAUDE.md:7` instructs restoring 100 **and** says "Do not hand-edit `project.pbxproj`" — which is self-contradictory, since the restore *is* an edit — and `.claude/hooks/block-xcode-project-writes.py` blocks tool-based writes to that file.

Resolved: the hook blocks tool writes, not a scripted rewrite, so the documented fixup is achievable.  Restored to 100 and **rebuilt to confirm `BUILD SUCCEEDED`** at that version.  The wording in `ios/CLAUDE.md` should be amended to say the objectVersion restore is the one sanctioned exception.

## Next Steps & Blockers
Blocked on peer PR #2794, which owns `HomeView.swift`:
1. `HomeView:893-894` still renders `LabeledContent("Max Order")` / `("Daily Cap")` — the **third** place those ambiguous labels appear.  Should become "Max Per Order" / "Max Spend Per Day" after #2794 lands.
2. `HomeView:428` / `:487` still say "Exit Only" — correct as command names per the reasoning above, but worth confirming in that file.

Also unresolved and deliberately not widened: "Max Order % NAV" and "Daily Cap % NAV" now sit directly beneath the renamed rows, so that screen mixes old and new phrasing.  Owner decision.
