# 2026-07-18 - account-rename-and-legacy-retirement

## Summary

Two owner-directed changes on branch `monet/vigilant-fermi-220244` (restarted off latest
`main` after PR #1685 merged):

1. **Editable connected-account display name.** Console Settings → Broker connections now lets
   the owner rename a connected account's cosmetic label inline (pencil affordance → input →
   save). Broker-parity with the legacy app, which had this. The broker-sourced account number
   is deliberately NOT editable — it stays fetched from the broker and keeps keying trade
   history and `policy.accountNumber`.

2. **Retire remaining legacy-app (old-dashboard-era) code.** The pre-console cockpit was already
   removed in earlier work; this deletes the last unused old-era remnants: two dead `app/ui`
   files and the `/old` redirect shim. The public/marketing pages are still in use (they are the
   current public renderer, kept deliberately per the 2026-07-16 "two renderers, one brand core"
   decision), so they were NOT touched — per the owner's scope ("legacy = old dashboard/console
   and anything else from that time we are not using now").

## Why

- Owner: "Should be able to edit connected accounts' names ... like could on legacy app." Scope
  narrowed by the owner to the cosmetic name only ("Keep on getting the real account number from
  broker and don't make that editable").
- Owner: "fully retire anything of the legacy app that remains," clarified as the old
  dashboard/console era code we no longer use — i.e. dead code, not the live public pages.

## Account rename — design

The DB layer already supported a user-scoped update, but the only existing write path was
`POST /api/connected-accounts` → `upsertConnectedAccount`, which re-runs connect-time validation
(Alpaca requires accountNumber + apiKey) and would force re-entering credentials to rename. So a
narrow, purpose-built path was added instead:

- `src/lib/db-api-keys.ts` → **`renameConnectedAccount(id, label, userId)`** — a single
  `UPDATE connected_accounts SET label = ?, updated_at = ? WHERE id = ? AND user_id = ?`. It
  touches ONLY `label`; it structurally cannot mutate `account_number`, credentials, capabilities,
  or the active pointer. Validates non-empty (trimmed) and ≤120 chars; returns false on no match.
- `app/api/connected-accounts/[id]/route.ts` → new **`PATCH`** handler: requires a `label`
  string (400 otherwise), calls `renameConnectedAccount`, 404 on unknown/foreign id. A test proves
  that even if a client also sends `accountNumber` in the body, it is ignored.
- `app/console/settings/lib.ts` → **`renameAccount(id, label)`** client helper (PATCH).
- `app/console/settings/brokers.tsx` → inline rename control in each account row: a pencil button
  swaps the name for a `TextInput` with Save (✓) / Cancel (✕); Enter saves, Escape cancels;
  success/error toasts; refreshes console data. `label` is display-only (no joins, no uniqueness,
  no policy coupling), so this is safe.

Account-number semantics left unchanged (broker identifier; user-typed for Alpaca/Tradier,
broker-synced for Robinhood). The add-account flow was NOT changed.

## Legacy retirement — what was removed vs kept

Removed (unused old-dashboard-era code, verified zero live importers on latest `main`):

- `app/ui/price-chart.tsx` — dead component, zero importers anywhere.
- `app/ui/model-picker.tsx` — dead custom dropdown (the console assistant uses its own picker;
  zero importers of the component). Its still-used type surface (`PickerProviderId`, `ModelOption`,
  `ModelGroup`) was inlined into `app/ui/llm-model-catalog.ts` (the catalog's own home) before
  deletion.
- `app/old/page.tsx` (+ the now-empty `app/old/`) — the legacy-dashboard redirect shim. Nothing in
  the app links to `/old` (verified); the old cockpit it fronted is long gone.
- Stale-comment cleanup: `app/console/ui/provider-logo.tsx` no longer implies the deleted
  model-picker still exists.

Kept — deliberately, because they are in current use (NOT old-dashboard-era):

- `app/ui/primitives.tsx` (`Card`/`Button`/`buttonClass`), `app/ui/theme.tsx`
  (`ThemeProvider`/`themeInitScript`/`useTheme`), `app/ui/cn.ts` — the **public renderer** for the
  live marketing/legal pages (welcome, how-it-works, framework, privacy, terms) + the root
  `app/error.tsx` boundary. Retained per the 2026-07-16 "two renderers, one brand core" decision;
  the owner's scope excludes pages still in use.
- `app/strategy/page.tsx` — a marketing SEO/canonical redirect to `/how-it-works` (NAV_V2 rename),
  not old-dashboard code.
- `public/model-logos/*.svg` — still rendered by the console's own `provider-logo.tsx`.
- `buttonClass` (design-sync UI-kit tooling re-export) and `useTheme` (documented public theme
  API) — current, not old-era; left in place.
- `paperMode`/`dryRun` legacy-key-stripping shims in `db.ts` / `db-profiles.ts` — defensive
  migration that strips stale keys from old stored policy JSON; harmless to keep.

## Files

- `src/lib/db-api-keys.ts` — `renameConnectedAccount`.
- `app/api/connected-accounts/[id]/route.ts` — `PATCH` handler.
- `app/console/settings/lib.ts` — `renameAccount` helper.
- `app/console/settings/brokers.tsx` — inline rename UI.
- `app/ui/llm-model-catalog.ts` — inlined model-catalog types.
- `app/console/ui/provider-logo.tsx` — comment fix.
- Deleted: `app/ui/price-chart.tsx`, `app/ui/model-picker.tsx`, `app/old/page.tsx`.
- `test/connected-accounts-route.test.ts` — 5 new rename tests (db + PATCH, label-only guarantee,
  scope, validation, 404).
- Docs: this note, `STATUS.md`, `docs/EFFORT-LOG.md`.

## Verification

Full gate on the final tree (Node 22, cloud session):

- `npm run build` — clean.
- `npx tsc --noEmit` — clean (the `.next/types` stale-reference errors from deleting `/old`
  cleared once `build` regenerated the generated types).
- `npm run lint` — 0 errors (498 pre-existing grandfathered warnings).
- `npm test` — **405 files / 4,763 tests passed** (incl. 5 new rename tests). One cosmetic
  vitest-pool worker-teardown warning on `console-sheet.test.tsx`; suite exit code 0.
- Rename logic exercised end-to-end by the new tests (db `renameConnectedAccount` + the `PATCH`
  route, including the guarantee that a `accountNumber` sent in the body is ignored). The console
  UI is standard inline-edit; the authed `/console` is not reachable from this cloud session for a
  live screenshot (documented OAuth access gap) — verification is the test suite + build.

## Codex review (round 1) — two rename-durability fixes

Both P2 findings were real bugs in the new rename feature; fixed with regression tests:

- **Rename must not perturb credential recency.** `renameConnectedAccount` originally bumped
  `updated_at`, but `getConnectedAccountByBroker` resolves which same-broker row backs shared
  data-source fetches (e.g. Tradier price history in `history.ts`) via
  `ORDER BY is_active DESC, updated_at DESC`. A cosmetic rename of an inactive row could promote it
  and swap an old/sandbox token into history fetches. Fix: the rename UPDATE now touches ONLY
  `label`, never `updated_at`. Test: renaming the older of two Tradier rows leaves
  `getConnectedAccountByBroker` returning the newer row, and the row's `updated_at` is unchanged.
- **Rename must survive a Robinhood re-sync.** `POST /api/connected-accounts` (Sync Robinhood /
  OAuth return) reused the existing row but passed `label: agentic.label || "Robinhood Agentic"`,
  which the upsert's conflict path writes — silently reverting a renamed account. Fix: the
  Robinhood branch now preserves `existing?.label` on re-sync, taking the broker label only when
  first creating the row. Test: rename a synced Robinhood account, re-sync, assert the custom name
  persists.

## Follow-ups

- The add-account form still asks for a user-typed account number for Alpaca/Tradier (only
  Robinhood auto-fetches it). Surfaced to the owner as a possible future change (auto-fetch on
  connect); left as-is for now — it touches the money-path connect logic and was not directed.
- Fully eliminating `app/ui/primitives.tsx` remains possible only by porting the public pages onto
  `con-*` — that reverses the "two renderers" decision and changes the marketing look, so it stays
  deferred pending an explicit owner call.
