# 2026-07-09 — Unsaved-changes nav prompt: 3 options (Discard / Keep editing / Review & save) (MONET)

Branch: `monet/unsaved-changes-3opt`

## Summary

When you navigate away (nav rail, mobile tab bar, or the mobile Tabs picker) from a page with
unsaved edits, the guard used a 2-option `window.confirm("Discard unsaved changes?")` — OK discarded
and left, Cancel stayed. There was no way to keep the changes AND go save them. It now opens a
3-option in-app prompt:

- **Discard changes** — leave the page (client-side `router.push` to the intended destination),
  losing the edits.
- **Keep editing** — stay on the page (also the Esc / X / scrim action).
- **Review & save** — stay and open this screen's review-and-commit panel. Shown only when the dirty
  screen registered a review opener; the Guardrails page does (opens its "Review changes" sheet). The
  Framework/strategy page has no separate review sheet (its pending AI-tuning review is inline), so it
  shows the two-button form.

## Why

Owner report: the unsaved-changes warning should offer discard, go-back (stay), and review/save —
not just discard-or-cancel.

## How

- `app/console/lib/useDirtyGuard.tsx` — rewritten. `useUnsavedChanges(dirty, onReview?)` now also
  registers an optional review opener. `useNavDirtyGuard()` returns `(event, href) => boolean`: when
  any draft is dirty it cancels the control's own navigation and opens the prompt (a `Sheet`); the
  `href` is navigated to (client-side) only on Discard. The prompt renders at the provider level with
  three `Btn`s (the third gated on a registered review opener). Dirtiness still lives in a ref'd Map
  so keystrokes never re-render the shell — only opening the prompt sets React state.
- `app/console/components/nav.tsx` — all three nav call sites pass the destination `href`
  (`guardNav(e, d.href)`); the `TabsSheet` `guardNav` prop type updated to the new signature.
- `app/console/components/policy-form.tsx` — `PolicySaveBar` registers
  `useUnsavedChanges(changeCount > 0, () => setReviewOpen(true))` so "Review & save" opens the review
  sheet.
- The Framework page (`strategy/page.tsx`) keeps `useUnsavedChanges(review !== null)` (no review
  opener) — the optional second arg means no code change there.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (one pre-existing `set-state-in-effect` warning in `sheet.tsx`, unrelated).
- `npx vitest run` — 3246 passed (310 files).
- `npm run build` — green (exit 0).
- Logic review of the flow (Discard → `router.push`; Keep editing / Esc → stay; Review & save →
  open review sheet, no nav). Browser-interaction check to be confirmed on the running app (Chrome
  MCP was unavailable this session).

## Follow-ups / notes

- The command palette navigates via `router.push` on select and does NOT currently route through the
  guard — a pre-existing gap, unchanged here; worth a follow-up so cmdk navigation also prompts.
- `#1277` (claude/ui-polish-wave) also touches `nav.tsx` (mobile tabs); this branch merged
  `origin/main` before landing to reconcile.
- `#1/#2/#4` of the settings-UX batch landed separately as `#1270`; `#5` (SEC EDGAR "contact"
  labels) landed via the credential-naming change. This PR is the remaining item (#3).
