# 2026-07-01 — NAV_V2 PR #1: vocabulary relabels + scope-surfacing (first app code)

Branch: `claude/settings-navigation-redesign-a3k1yv-mce45j`. First **app-code** step of the
settings-navigation redesign; executes PR #1 of the delivery plan
(`docs/settings-navigation-redesign/spec/08-delivery-plan-prs-and-tests.md`). Ships **no flag** —
pure clarifying copy on the current IA + surfacing the already-coded account/user tier split.

## Summary
Killed duplicated-label confusion and made the hidden account-vs-user settings tier legible, without
moving a panel or touching a data path.

- **Relabels (copy only)** in `app/dashboard-client.tsx`:
  - Chrome kill button `Stop` → **`STOP`**; tooltip now reads "Halts new activity in one click. Always
    safe — never sells anything you hold." **Handler byte-identical** (the real STOP/Flatten split lands
    in PR #9).
  - Feed tab `Notifications` → **`Alert history`**; feed slide-over subtitle "…runs & notifications" →
    "…runs & alerts".
  - Settings sections `Display` → **`Appearance`**, `Notifications` → **`Alert delivery`**, `Data` →
    **`Data & Privacy`**. In-section field copy `Notifications Webhook` → `Alerts webhook`,
    `Send notifications for` → `Send alerts for`.
  - User-tier scope-detail string + Help "Settings Glossary" intro updated to the new nouns (and now name
    the `ALL ACCOUNTS` / `THIS ACCOUNT` tags).
- **Scope-surfacing:** each settings-section header now renders a **`THIS ACCOUNT`** (account tier) or
  **`ALL ACCOUNTS`** (user tier) `Chip`, driven by `scopeTagForSection(section)`. The data already
  existed (`settingsTierForSection`); this only displays it.
- **New module `app/settings-scope.ts`:** extracted `SettingsSection` / `SettingsTier` /
  `ACCOUNT_SETTINGS_SECTIONS` / `settingsTierForSection` out of the client (values/types unchanged) and
  added `SCOPE_TAG_LABEL` + `scopeTagForSection`, so the scope-tag copy has one source of truth the
  client and tests share (avoids the enrichment-drift trap). No `src/lib`, no API, no schema.

## Why
PR #1 in the approved delivery plan: safe, flag-free clarifying copy ahead of the shell. Acceptance
criteria: (1) no bare "Notifications" nav/section label; (2) every settings-section header shows the
correct tier tag; (3) kill button reads "STOP" with a never-sells tooltip and an unchanged handler;
(4) Help glossary + palette labels match the new copy. Copy is normative per
`docs/settings-navigation-redesign/spec/09-copy-deck.md`.

## Files
- Added: `app/settings-scope.ts`
- Added: `test/scope-tag-render.test.ts`
- Modified: `app/dashboard-client.tsx` (labels + scope-tag Chip; local scope defs moved to the new module)
- Docs: `STATUS.md`, `PLAN.md`, this rollout note.

## Verification
Ran the full gate on this worktree (deps installed via `scripts/npm-ci-with-shared-deps.sh`, token present):
- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (258 pre-existing grandfathered warnings).
- `npm test` — 173 files / 1675 tests pass (was 172 / 1671; +1 file, +4 tests all new).
- `npm run build` — success.
Baseline before edits was green (172 / 1671). No existing test asserted on any relabeled string
(confirmed: the only `test/` "Notifications" hits are webhook-error DATA, out of scope), so nothing
required updating.

Reviewed adversarially via a Workflow (`pr1-nav-v2-review`, 7 agents): 4 review dimensions
(acceptance / safety / completeness / test-rigor) each with per-finding refutation verification.
Acceptance, safety, and completeness dimensions returned **no findings**. One **minor** finding was
confirmed and **fixed**: the new test's `ALL_SECTIONS` list was hand-maintained (no compile-time
exhaustiveness guard) despite a comment claiming it was "provably exhaustive" — now derived from a
`satisfies Record<SettingsSection, number>` object so a new union member without a matching entry is a
`tsc` error, not silent coverage loss.

## Do-not-break checklist (PR #1)
- **[KILL-1CLICK]** STOP relabel keeps one-click-never-sells; `onClick` handler diff shows no edit. ✓
- **[ADMIN-GATE]** N/A (no admin change).
- Others N/A (copy-only; no execution/scope/data path touched).

## Follow-ups
- PR #2 (`DestinationTab` mapping + localStorage shim, behind `NAV_V2`) is next in the spine.
- Deferred by design to later PRs (do **not** treat as gaps here): destination renames
  Decision→Dashboard / Performance+Tax→Results (PR #2), the scope-first settings tree (PR #3),
  `openSettings` call-site rewrites + full glossary old→new table + `/admin` consolidation (PR #4),
  Strategy consolidation (PR #5/#6), and the real STOP/Flatten handler split (PR #9).
