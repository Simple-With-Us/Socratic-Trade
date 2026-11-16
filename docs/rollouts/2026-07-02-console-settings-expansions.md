# 2026-07-02 — /console/settings expansions: brokers, API keys, models, delivery, glossary (Claude)

## Summary

Expanded `/console/settings` to cover the account/integration management the
legacy dashboard had, re-implemented in the console's design grammar. Five new
sections (all new files under `app/console/settings/`, plus edits to the
settings page itself — no shared console file touched):

1. **Broker connections** (`brokers.tsx`) — replaces the read-only
   "Connected accounts" card. Connect Robinhood (checks
   `GET /api/broker/mcp/health`; authenticated → re-sync via
   `POST /api/connected-accounts {broker:"robinhood"}`, else full-page redirect
   to `GET /api/auth/robinhood/start`), connect Alpaca via an API-key sheet
   (`POST /api/connected-accounts {broker:"alpaca", …}` — paper/live inferred
   from the PA…/PK… credentials, previewed live in the sheet), per-row Make
   active (existing activate endpoint), and Disconnect with an explicit confirm
   sheet (`DELETE /api/connected-accounts/[id]`) that states exactly what is
   removed (the connection + stored credentials in this app) and what is not
   (anything at the broker); LIVE rows get the live-bordered sheet plus a note
   that app-managed stops cease. Handles `?robinhoodMcp=connected` return
   param by auto-syncing (parity with the legacy dashboard, which is where the
   OAuth callback currently redirects). Rows show broker/environment/account
   tail/tax treatment/capabilities and a "reconnect needed" chip when the
   Robinhood MCP session is dead.
2. **API keys** (`api-keys.tsx`) — full CRUD over `/api/keys`, grouped by the
   server catalog's categories (LLM, market data, price history, macro, …).
   Keys are write-only: the server never returns a stored value and the UI
   never shows one — each row shows a source chip ("your key" / "server key" /
   "not set", with hover explanations), last-saved time, the unlock blurb, and
   a "get a key" docs link. Add/Replace uses an inline password field +
   optional non-secret label; Remove has an inline destructive confirm.
3. **LLM models** (`models.tsx`) — strategist (`llmModel`, green team) and
   reviewer (`redTeamLlmModel`, red team) pickers as native grouped `<select>`s,
   saved through the same `PUT /api/policy` path (savePolicy) the page already
   uses; placed under THIS ACCOUNT because policy is account-scoped.
   `GET /api/chat/providers` marks providers with no resolvable key: their
   options are disabled + annotated, and a warning strip appears when the
   CURRENT selection has no key. Blank = honest defaults ("app default
   (gpt-5.4-mini)" / "same as strategist"); clearing sends `null`, which the
   policy route strips back to absent (empty string is rejected server-side).
   A stored custom model id outside the catalog still renders as selected
   ("custom id" option) rather than lying. The catalog is a console-local COPY
   of the data in `app/ui/llm-model-catalog.ts` (console imports no legacy UI
   components; keep the two lists in sync when adding models).
4. **Delivery channels** (`delivery.tsx`) — replaces the status-only card with
   a full port of the legacy DeliveryChannelsPanel: reads
   `GET /api/notifications` (channel availability + prefs), per-channel
   toggle + target field (push topic / webhook URL / email / phone),
   unavailable channels say "not configured on the server" instead of failing,
   save via `POST /api/notifications`, "Send test" persists the draft first
   then exercises every enabled channel with per-channel results. Draft is
   dirty-guarded.
5. **Help & glossary** (`help.tsx`) — a new REFERENCE section: searchable,
   collapsible glossary of the console's load-bearing vocabulary (TEST/PAPER/
   LIVE, Ask-first/Autopilot, arming, system states, STOP semantics, green/red
   team, conviction, policy gate, guardrails, circuit breaker, broker vs app
   stops, wash-sale guard, account scope, presets, "—" vs "n/a", source
   attribution). Static by design; definitions mirror actual behavior.

Cross-cutting (owner UX standard, baked into every section incl. the retained
cards in `page.tsx`): **tooltips everywhere** — every control, toggle, field,
chip, row, and icon-only affordance carries a concise native `title=`
explanation — and **row hover highlight** on all list rows (accounts, keys,
channels, glossary, event checkboxes) via inline Tailwind with existing
`--con-*` tokens (`hover:bg-[color:var(--con-surface-2)]`, plus
focus-visible/focus-within variants), light + dark.

New `app/console/settings/lib.ts` holds the section's typed fetch helpers
(self-contained; reuses only `ConsoleApiError` from `../lib/api` so errors
surface through the same toast pattern — the shared client file is untouched).

## Why

Parallel-team port of legacy features into `/console`; this lane owned the
settings surface (broker connect/manage, API keys, model selection, delivery
channels, help/glossary). Hard collision constraints honored: no edits to
`console.css`, `components/nav.tsx`, `lib/api.ts`, `approval-card.tsx`,
`positions.tsx`, `approvals/page.tsx`, or any `src/lib/*`; no imports from
`app/console/ui/ticker-logo|provider-logo|symbol-drilldown` or
`app/console/lib/models` (absent on this base); model picker is a native
grouped select rather than the legacy `app/ui/model-picker`.

## Files

- `app/console/settings/lib.ts` — NEW: typed fetch helpers + payload types for
  /api/keys, /api/connected-accounts (+ Robinhood sync/health), /api/chat/providers,
  /api/notifications.
- `app/console/settings/brokers.tsx` — NEW: BrokerAccountsCard + AlpacaConnectSheet.
- `app/console/settings/api-keys.tsx` — NEW: ApiKeysCard + KeyEditor.
- `app/console/settings/models.tsx` — NEW: ModelsCard + local curated catalog copy.
- `app/console/settings/delivery.tsx` — NEW: DeliveryChannelsCard.
- `app/console/settings/help.tsx` — NEW: HelpGlossaryCard.
- `app/console/settings/page.tsx` — EDIT: wires the new cards (ModelsCard under
  THIS ACCOUNT; brokers/API keys/delivery under ALL YOUR ACCOUNTS; glossary
  under a new REFERENCE tag), removes the superseded ConnectionsCard and
  status-only DeliveryChannelsCard, adds tooltips + hover highlights to the
  retained cards (tax, event notifications, scan shape, boot behavior, You).
- `STATUS.md`, `PLAN.md`, `docs/rollouts/2026-07-02-console-settings-expansions.md` — handoff.

## Verification

Run in this worktree (branch `claude/console-settings-expansions`, cut from
`origin/main` @ 78ecc98):

```bash
npx tsc --noEmit    # clean (the known test/alternative-data.test.ts issue did not reproduce)
npm run lint        # 0 errors, 285 warnings (all pre-existing patterns; the 4 in new files
                    #   are the grandfathered react-hooks/set-state-in-effect fetch-on-mount
                    #   pattern the console data layer already uses)
npm test            # 234 files, 2241 tests — all pass
npm run build       # succeeds; /console/settings builds
```

Runtime smoke (prod server on :3123): `/console/settings` → 200;
`GET /api/keys`, `/api/notifications`, `/api/chat/providers` → 200 with
payloads matching the typed helpers exactly (keys: catalog entries with
`configured`/`source: "user"|"env"|"none"`; notifications: channel descriptors
+ prefs; providers: per-provider booleans).

## Follow-ups

- **Model picker upgrade:** using native grouped `<select>`s per the collision
  constraints; once the foundation lane's `provider-logo` / `app/console/lib/models`
  land, consider upgrading to a logo picker and de-duplicating the console-local
  catalog copy (also duplicated by `strategy/page.tsx`'s import of the legacy
  catalog data — a shared console-side catalog module is the natural merge).
- **OAuth return target:** `GET /api/auth/robinhood/callback` still redirects to
  the legacy dashboard (`/?robinhoodMcp=connected`), which completes the account
  sync there. The console handles the same param defensively, but a
  console-native return (e.g. `/console/settings?robinhoodMcp=connected`) needs
  a change outside this lane's file set.
- **Strategy-page overlap:** `strategy/page.tsx` edits the same `llmModel` /
  `redTeamLlmModel` fields as free-text inputs; both write through
  `PUT /api/policy` so they can't conflict, but converging on one picker
  component later would be cleaner.
- The reviewer-model failover fields (`llmFallbackModels`) and reasoning effort
  stay on the Strategy screen; Settings deliberately owns only the two primary
  model choices.
- Robinhood MCP health is checked once on mount; a stale "reconnect needed"
  chip clears on reload — cheap to poll later if it bites.
