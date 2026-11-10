# 2026-08-02 — Mobile PWA: owner feedback round (accounts, approval feedback, delete de-emphasis)

## Context & Objective

Owner (Jay) reported three problems with the mobile PWA (`socratictrade.com/mobile`, screenshot 2026-08-02):
no way to change accounts from the PWA; tapping Approve on a trade "feels like nothing happens" with no
visibility into what state the order/command is in; and the Delete-app-account section is oversized and
styled identically to the failed-command/error banners around it. This work addresses all three in
`app/mobile/mobile-pwa-client.tsx`.

## Changes Made

High level:

1. **Header Account Selector dropdown.** The snapshot carries `connectedAccounts` and `currentUser`. An Account Selector dropdown `<select>` is now rendered right in the sticky top header bar, allowing instant switching between connected broker accounts via `account.activate`. Selecting an account activates it while displaying an inline spinner. A Sign Out link is placed alongside it to switch logins when needed. The redundant, separate body "Accounts section" was removed per owner clarification.

2. **Per-action realtime feedback.** Root cause of the "dead approve": `POST /api/mobile/commands`
   returns `202 queued` and the worker executes async; worker failures (e.g. "Proposal is already
   blocked.") only ever surfaced in the Command Log at the bottom of the page. Now:
   - `submitCommand` accepts an action key + proposal context; new `busyKey` state makes only the tapped
     control spin (all four strategy buttons + Activate + Approve/Reject get spinners).
   - The accepted command id is recorded per proposal (`proposalCommandIds`) and the card follows its own
     command through `recentCommands`: queued → running → succeeded/failed, rendered as an inline banner
     on the card (`proposalActionFeedback`, exported pure function, unit-tested). SSE
     (`/api/mobile/events` → `mobile.command`) already triggers snapshot reloads, so the banner updates
     in near-realtime without new plumbing.
   - Submit-time failures for approve/reject render on the card itself (`proposalNotices`) instead of
     only the global top banner (which is off-screen when scrolled to Approvals).
   - Approve/Reject buttons disable + relabel ("Approving…"/"Rejecting…") while their command is in
     flight; a succeeded banner shows until the refresh removes the card.

3. **Delete-account de-emphasis.** The always-visible red panel is now collapsed by default behind a
   small neutral text link ("Delete app account…") under a divider at the very bottom. Red styling only
   appears after an explicit tap. Expanded panel gains a "Keep account" collapse button; Cancel in the
   typed-confirmation flow also collapses. The two-step typed confirmation flow itself is unchanged.

Files touched:
- `app/mobile/mobile-pwa-client.tsx` (all three changes)
- `test/mobile-pwa-client.test.tsx` (new `proposalActionFeedback` suite, 5 tests)
- `STATUS.md`, `docs/EFFORT-LOG.md`, this rollout note

## Decisions & Trade-offs

- No new API surface: account switching reuses the existing `account.activate` command and snapshot
  fields; feedback reuses `recentCommands` + SSE. Zero server changes.
- `MobileCommand` type is now exported (needed by the exported `proposalActionFeedback` signature).
- Activate button shows a spinner only during the POST; subsequent state comes via the command log and
  the Active badge moving after refresh. Proposals got the full tracked treatment because that's where
  the pain was; extending tracking to activate is a cheap follow-up if wanted.
- Delete flow: collapsing (rather than moving to a separate settings page) keeps App-Store-style
  account-deletion discoverability while removing the visual false-alarm.
- Pre-existing lint warnings (react-hooks/set-state-in-effect at the `navigator.onLine` effect;
  react/no-unescaped-entities in the deletion body copy) left untouched — both predate this change.

## Verification State

Run in the cloud session (Node v22.22.2, `npm ci` clean):

- `npx tsc --noEmit` — clean, 0 errors.
- `npx vitest run test/mobile-pwa-client.test.tsx` — 10/10 passed (5 pre-existing + 5 new).
- `npx eslint app/mobile/mobile-pwa-client.tsx test/mobile-pwa-client.test.tsx` — 0 errors,
  2 pre-existing warnings (see above).
- Full `npx vitest run` — 5,607/5,611 passed (485/486 files). The 4 failures are all in
  `test/server-metrics.test.ts` and are environment-specific to this cloud sandbox: its egress proxy
  injects a GitHub credential (`Authorization: Bearer proxy-injected`), which makes the route perform an
  extra `api.github.com/.../actions/runners` fetch the test's call-count assertions don't expect. File
  untouched by this change; expected green on lane machines.
- `next build` not run here; the land.sh gate must run it at landing per AGENTS.md.

## Next Steps & Blockers

- **Blocker: this session had no push credentials** (anonymous clone). The change is delivered to the
  owner as a `git am`-able patch from branch `agent/monet/mobile-pwa-feedback`. A lane agent should apply
  it in `~/apps/trading-monet`, run the full gate, and land via `scripts/land.sh`.
- Follow-ups worth considering: tracked-command feedback on Activate; surface the executed order id/fill
  state on the success banner; owner mentioned wanting "a little more features" on the PWA — scope TBD.
