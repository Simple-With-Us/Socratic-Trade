# 2026-06-30 — Congress event ingest: App A wire-shape parity

## Summary

Made App B's congress-event ingestion tolerant of every shape App A
(congress.trade) actually sends on both the webhook and SSE channels, fixing a
silent trade-drop. `applyCongressEvent` previously accepted only the canonical
`{ type: "congress.trade", data: { trades: [...] } }` envelope.

## Why

Cross-app review of the Congress.Trade ↔ Agentic Trading contract found the
real-time channel was dropping trades end-to-end:

- **Webhook:** App A posts `{ event: "trade.new", transaction: <tx> }`
  (`src/delivery/webhook.ts`). App B read `.type` / `.data.trades`, so the body
  failed as `invalid-event` → HTTP 400 → App A retried then dead-lettered. The
  webhook has never delivered a trade.
- **SSE:** App A emitted `event: trade.new` (now `congress.trade`), and the
  stream client overlays the event name onto `env.type` while the `data:` line
  is the payload — so trades arrive at the top level (`env.trades`), not under
  `env.data.trades`. Both the old `trade.new` name and the flattened shape were
  dropped as `unknown-type` / `no-trades`.

The canonical event type is `congress.trade` per
`@jaywedgeworth22/congress-trading-shared` (`CONGRESS_EVENT_TYPES`). Rather than
depend on App A shipping a matching change first, App B now accepts all shapes
(Postel's law) so it works across the rollout window in either direction.

## What changed

`src/lib/congress-trade-events.ts` — `applyCongressEvent`:
- Resolve the event type from `type` **or** the legacy `event` field; treat
  `trade.new` as an alias of `congress.trade`.
- Collect trade rows from `data.trades`, top-level `trades`, `transaction` /
  `data.transaction`, and (last resort) the envelope itself, then coerce+dedupe
  as before. Idempotency, validation, and the insider/ref/price/spx branches are
  unchanged.

`test/congress-webhook-parity.test.ts` — new regression suite covering the
webhook shape, the `trade.new` alias, the flattened SSE frame, the canonical
envelope, and the typeless-reject case.

## Connection monitoring (admin visibility)

So the App A → App B link is observable to admins on both sides, the inbound
channels now log to `api_health_log`, which the existing **admin Connections
Health** page (`app/admin/connections`) surfaces automatically:

- `src/lib/congress-stream.ts` — logs `congress.trade:sse` ok on each (re)connect
  (with connect latency) and ok:false with the error on connection failure.
- `app/api/webhooks/congress/route.ts` — logs `congress.trade:webhook` after
  payload application: ok:true for accepted events and ok:false with the apply
  reason for unsupported single events or batches with any rejected item.

The App A side surfaces the outbound half: a "Cross-App Trade Delivery" card in
Congress.Trade's `/api/admin/diagnostics` (24h delivered/failed/pending +
dead-lettered counts) — Congress.Trade PR #123.

## Cross-app note

The counterpart App A change — emit the canonical `congress.trade` on **SSE and
the webhook** — is in Congress.Trade PR #123 (the webhook now sends a superset
payload with `type`/`id`/`data.trades` alongside the legacy fields). This App B
change makes ingestion robust regardless of App A's deploy timing.

## Verification (run in the worktree)

- `npx vitest run test/congress-trade-events.test.ts test/congress-webhook-parity.test.ts test/congress-stream.test.ts` → 30 passed
- `npx eslint src/lib/congress-trade-events.ts test/congress-webhook-parity.test.ts` → clean
- `npx tsc --noEmit` → clean

## Next

- Align App A's webhook to emit `congress.trade` (Congress.Trade side).
- Consider hoisting a shared "coerce trades from any envelope" helper into
  `congress-trading-shared` so both apps share one tolerant reader.

## 2026-07-01 — [codex-autofix] bare-tx envelope-field strip + handoff docs

Addresses the two Codex review threads on PR #283.

**P2 correctness — strip envelope fields before coercing a bare payload.** The
"last resort: the envelope itself is one trade" branch pushed the whole `raw`
envelope into `coerceCongressTrade`. But `applySseMessage`
(`src/lib/congress-stream.ts`) copies the SSE event name into `env.type`, and
`coerceCongressTrade` reads `type` **before** `txType` when resolving the trade
side. So a bare App A transaction arriving over SSE (top-level `txType: "P"/"S"`,
no `trades` array) had its valid side shadowed by the envelope `type`
(`"congress.trade"` / `"trade.new"`) → `side` unresolved → the row was dropped as
`no-trades`. Fix: when treating the envelope as a bare transaction, shallow-copy
`raw` and `delete` the envelope-level keys (`type`, `event`, `id`, `data`) so the
transaction-side fields win. Files: `src/lib/congress-trade-events.ts`.

Added a regression test to `test/congress-webhook-parity.test.ts` for the
bare-tx SSE frame whose envelope `type` was stamped by `applySseMessage`;
confirmed it fails (`applied` 0) on the pre-fix code and passes after.

**P2 handoff docs.** Updated `STATUS.md` and `PLAN.md` alongside this note, per
the AGENTS.md Pre-Commit / Handoff Protocol (the original commit added only this
rollout note).

### Verification (this round)

The private `@jaywedgeworth22/congress-trading-shared` git dependency is not
fetchable in the CI/autofix sandbox (the available GitHub token has no access —
`git ls-remote`/`gh api` both 404), so a full `npm install` fails and the
whole-project `tsc`/`build` cannot run here. Verified the change against a local
stub package (pass-through schemas) that let the rest of the dep tree install:

- `npx vitest run test/congress-webhook-parity.test.ts test/congress-trade-events.test.ts` → 25 passed (incl. new regression test; confirmed it fails on the pre-fix code)
- `npx eslint src/lib/congress-trade-events.ts test/congress-webhook-parity.test.ts` → clean
- `npx tsc --noEmit` → **no errors in the touched files**; the only errors reported are `no exported member` in files that import *types* from the shared package, which are artifacts of the minimal stub's `.d.ts`, not of this change.

The `verify` CI job runs with real registry access and will exercise the full
trio on push.

## 2026-07-01 — webhook health review fix

Codex review caught that webhook health was logged `ok:true` immediately after
authentication, before `applyCongressEvent` could reject unsupported payloads.
The route now logs health after application. Single-event failures record the
`ApplyResult.reason`; batch payloads record ok:false if any item failed.

Regression: `test/congress-trade-events.test.ts` drives the real
`app/api/webhooks/congress/route.ts` POST handler with an authenticated invalid
payload and verifies the admin-facing `getServiceHealthSummaries()` row has
`lastFailureError: "invalid-event"` and no last success.

### Verification (this round)

- `npx vitest run test/congress-trade-events.test.ts test/congress-webhook-parity.test.ts` — 26 tests pass.
- `npx tsc --noEmit` — clean.

## 2026-07-01 — bare transaction event/type precedence fix

Review caught one remaining App A wire-shape edge: a bare transaction may carry
`event: "trade.new"` as the envelope event name while retaining transaction-side
`type: "purchase"` / `"sale"` as a side alias. Event resolution now treats
`raw.type` as the event only when it is a known event name; otherwise
`raw.event` can supply the event name and `raw.type` remains available to
`coerceCongressTrade`.

Regression: `test/congress-webhook-parity.test.ts` now covers
`{ event: "trade.new", type: "purchase", ticker, txDate }`.

### Verification (this round)

- `npx vitest run test/congress-trade-events.test.ts test/congress-webhook-parity.test.ts` — 27 tests pass.
- `npx tsc --noEmit` — clean.
