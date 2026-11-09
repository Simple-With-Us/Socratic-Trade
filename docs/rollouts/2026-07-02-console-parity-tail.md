# 2026-07-02 — /console parity tail: run-blocked routing, sign-out, allocation, watchlist+alerts, consent, sharing, deletion, admin links, badge fold-in (Claude)

## Summary

The remaining smaller items from the legacy-vs-console parity audit, landed as one
branch (`claude/console-parity-tail`, cut from `origin/main` @ 93aed63 after #321/#322):

- **(a) Run-once blocked-reason routing** (`app/console/components/chrome.tsx`):
  `RunOnceButton` no longer hides "why" in a disabled button's hover tooltip
  (useless on mobile). Pre-flight blocks (no LLM key, account not ready) keep the
  button clickable — the click opens a sheet stating WHY plus a one-click route to
  the fix (`/console/settings#api-keys`, `#brokers`). Server refusals from
  `POST /api/strategy/run` (412 LLM gate, 400 failed run) are classified against
  the server's own summary strings (kill switch → Guardrails, run-in-progress →
  Activity, budget → Strategy, account → Settings#brokers, default → Activity).
  The halted branch's copy states honestly that Stopped also pauses app-managed
  stop-losses (never claims halting is "always safe").
- **(b) Sign-out** (`chrome.tsx` `UserMenu`, mounted in `shell.tsx`): identity
  button in the chrome (name/email/provider/admin), sheet with an honest note
  (signing out doesn't change the run state) and a Sign out link to the existing
  `/logout` route (clears Auth.js session cookies → `/login`). Renders only when
  `snapshot.currentUser` exists — nothing to sign out of in local single-user mode.
- **(c) Allocation view** (`app/console/components/allocation.tsx`, mounted on
  Home below Positions): the legacy donut ported as labeled horizontal bars —
  by-position and by-sector lenses, Cash always its own segment, positions
  without provider sector data grouped as "No sector data" (never guessed),
  reality chip (TEST/PAPER/LIVE wording) in the card title.
- **(d) Watchlist + price alerts** (`app/console/watchlist/page.tsx`, new nav
  destination after Scan; mobile primary tabs unchanged): full destination over
  the existing endpoints — GET/POST/DELETE `/api/watchlist` (symbols + broker
  quotes; missing quote renders "—") and GET/POST/DELETE `/api/alerts`
  (above/below threshold, note, armed/triggered lifecycle, per-row delete,
  "Alert" quick-action prefilled with the current price). Copy states the real
  mechanics: checked ~once a minute while the server runs, fires once, never
  re-arms itself, notifies via the `price_alert` event, never trades.
- **(e) Admin links** (`app/console/settings/page.tsx` `AdminLinksCard`):
  OPERATOR section (visible only to `currentUser.isAdmin`) linking to
  `/admin/connections`, `/admin/llm-usage`, `/admin/rag-coverage`,
  `/admin/transcript` — links only, no new admin UI.
- **(f) Consent gate** (`app/console/components/consent-gate.tsx`, mounted in
  `shell.tsx`): console port of the legacy blocking shared-market-data-pool
  dialog, same un-weakened semantics — `GET /api/consent` `needsConsent` ⇒
  blocking overlay until Agree/Decline is POSTed; fetch failure fails CLOSED
  (asks rather than proceeds); answer changeable later in Settings → Data sharing.
- **(g) Account deletion** (`app/console/settings/danger.tsx`, DANGER section):
  the 3-stage flow over `GET/POST/DELETE /api/account/deletion` — scope preview
  (connections + row counts), activity blockers surfaced, prepare (explicitly
  labeled as stopping the strategy), five server-mirrored acknowledgements,
  typed email + `DELETE MY ACCOUNT` (+ local-operator phrase when applicable,
  paste blocked), then sign-out via the returned `logoutUrl`. Honest copy about
  what is NOT deleted (broker positions/orders, IdP accounts, OAuth grants).
- **(h) Learned-context sharing prefs** (`app/console/settings/sharing.tsx`):
  Data sharing card with the pool-consent toggle (same record as the gate) and
  the two `GET/PUT /api/learned-context/sharing` flags (`includeShared`,
  `contributeShared`), each described honestly (fact-tier only; risk/strategy
  directives never shared). Load failure locks controls instead of guessing.
- **(i) Nav badge fold-in** (`app/console/components/nav.tsx`): the single red
  Approvals badge now counts pending proposals PLUS pending learned-context
  items (`GET /api/learned-context/pending`, polled 60s + visibility), with a
  tooltip breaking the number down. One badge, one number — no second red badge.

## Why

Parity-tail lane of the parallel legacy→console port (follows #321 foundation and
#322 settings expansions; runs beside the scan/macro/orders/assistant/drilldown
lanes). Each item ports an existing legacy behavior onto existing endpoints —
no new backend surface was needed, so none was invented.

## Decisions

- Blocked "Run once" stays clickable and explains itself in a sheet (mobile has
  no hover); failure classification is string-matched against the server's own
  summary constants rather than a new error-code API.
- Learned-context count is folded into the existing badge (approvals page is the
  decision inbox for both after #324) instead of adding a second badge.
- Allocation uses bars, not a donut: readable at any segment count, every number
  labeled; single accent hue + muted cash keeps the console's color discipline.
- Watchlist is a full destination (not a Home section): it has two interactive
  surfaces (symbols, alerts) and its own mutation set; Home stays "what is my
  money doing right now".
- Deletion UI mirrors the server contract exactly (`src/lib/account-deletion.ts`
  read-only) — every gate the server enforces is visible up front.
- Declined pool consent re-prompts next session (`needsConsent` stays true) —
  matches legacy semantics deliberately; not weakened, not "fixed" here.

## Files

- `app/console/components/chrome.tsx` — RunOnceButton rework + UserMenu
- `app/console/components/shell.tsx` — UserMenu + ConsentGate mounts
- `app/console/components/consent-gate.tsx` — NEW blocking consent gate
- `app/console/components/allocation.tsx` — NEW allocation card
- `app/console/components/nav.tsx` — Watchlist destination; badge fold-in
- `app/console/page.tsx` — AllocationCard on Home
- `app/console/watchlist/page.tsx` — NEW watchlist + price alerts destination
- `app/console/settings/page.tsx` — anchors (#brokers/#api-keys/#sharing/#danger/#admin), hash scroll, OPERATOR + DANGER sections, AdminLinksCard
- `app/console/settings/sharing.tsx` — NEW data-sharing card
- `app/console/settings/danger.tsx` — NEW account-deletion card
- `STATUS.md`, `PLAN.md`, `docs/rollouts/2026-07-02-console-parity-tail.md` — docs

## Verification

```bash
npx tsc --noEmit    # clean
npm run lint        # 0 errors (289 grandfathered warnings; 1 in new code: the
                    # same set-state-in-effect fetch-on-mount pattern already
                    # used by useConsoleData/api-keys/brokers)
npm test            # 2241 tests / 234 files, all pass
npm run build       # green; /console/watchlist route present
```

Re-run after the pre-push `git merge origin/main` (see STATUS entry for result).

## Follow-ups

- Legacy had no dedicated watchlist/alerts UI wired to `/api/watchlist` +
  `/api/alerts` (endpoints existed unused by the dashboard) — the console
  destination is therefore a port of the backend contract, not of a legacy
  screen; owner may want a legacy-side link or removal of the dead endpoints'
  legacy plumbing later.
- Run-failure classification is substring-based on server summaries; if those
  strings change, the fallback (Activity link) still routes somewhere useful,
  but a structured error code from `/api/strategy/run` would be sturdier.
- Deletion flow: after #324's approvals inbox lands, consider surfacing pending
  learned-context items as a deletion "you'll lose these" line item.
- Skipped by owner decision (do NOT build): ⌘K palette, Strategy Flow visualizer.
