# 2026-06-21 — Short/cover broker-side translation (money-path fix)

## Summary

Closed a real Live-readiness money-path gap: the broker adapters forwarded our 4-value internal
`OrderSide` (`buy`/`sell`/`short`/`cover`) **raw** to broker order APIs that only accept `buy`/`sell`.
A live `short` or `cover` order was therefore an invalid broker request. This matters because the
synthetic-stops engine emits a `cover` exit **outside** the policy/approval path, so policy gating is
not a backstop there.

## What changed

- **`src/lib/broker-side.ts` (new):** `toBrokerSide(side)` maps intent → broker side
  (`buy`/`cover` → `"buy"`, `sell`/`short` → `"sell"` — a short opens via a sell, a cover closes via a
  buy; the broker infers open-vs-close from the account's current position). `isShortIntent(side)`
  flags `short`/`cover`.
- **`src/lib/alpaca.ts`:** both order-submission paths (REST `createOrder` and the MCP
  `place_*_order` args) now send `toBrokerSide(input.side)`. Alpaca supports shorting, so this makes
  short/cover actually function (still gated by `policy.shortSellingEnabled`, default off).
- **`src/lib/robinhood.ts`:** `toMcpOrder` now **fails closed** — it throws on `short`/`cover` before
  the network call (Robinhood MCP has no equity shorting). Exported for testing.

## Why

Audit "what's next" assessment flagged this as the highest-value missing money-path test and a real
Live blocker (`alpaca.ts` forwarded `side: input.side` raw at the order paths). Translating for the
broker that supports shorting and rejecting for the one that doesn't is the correct split; the LIVE
short gate remains policy's job (`shortSellingEnabled`).

## Verification

Built and verified in an isolated worktree `~/apps/trading-shortcover` off clean `origin/main`
(`cedac04`), shared `node_modules` — per the AGENTS.md rule to keep money-path/shared-file work out of
the churning integration/agent worktrees.

- `npx tsc --noEmit` — clean.
- `npm test` — **423 passed** (55 files), incl. new `test/broker-side.test.ts` (5): the `toBrokerSide`
  mapping, `isShortIntent`, Robinhood `toMcpOrder` rejection of short/cover, and an Alpaca
  `placeEquityOrder` end-to-end assertion (SDK mocked) that `short`→`sell` and `cover`→`buy` reach
  `createOrder`.
- `npm run build` — succeeded.

## Follow-ups

- The Test-mode simulator gateway keeps all four sides (it does its own short/cover accounting and
  never hits a real broker) — intentionally untouched.
- Per-broker short capability could later be data-driven via `AccountCapabilities.shortSelling`
  instead of the hardcoded Robinhood reject, if another short-capable broker is added.
