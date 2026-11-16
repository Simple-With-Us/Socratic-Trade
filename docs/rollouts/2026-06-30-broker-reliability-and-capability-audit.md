# 2026-06-30 - broker-reliability-and-capability-audit

## Summary

Three real code fixes, one diagnosis, and one research-backed capability plan, in response
to a user request to (1) make order-placement confirmation broker-agnostic, (2) make sure
the app uses everything Alpaca/Robinhood already offer, (3) explain why "Alpaca news and
something else" show as broken on the admin connection-status page, and (4) survey
Alpaca/Robinhood/eToro/Public.com/IBKR's full capability surface (including non-trading
uses and MCP) and produce an implementation plan.

Code fixes:

1. **Share-class symbol translation** extended beyond the trading gateway (already fixed
   earlier this session, PR #284) into the market-data enrichment and streaming paths,
   which had the identical `BRK-B`-vs-`BRK.B` bug independently.
2. **Broker-agnostic order-placement confirmation**: a non-throwing broker response that
   is actually a synchronous rejection/cancellation no longer gets recorded as `"placed"`.
3. **Robinhood order-id fabrication bug**: a malformed MCP response with no order id used
   to become the literal string `"undefined"` instead of failing loudly.

## Why

- A live-DB query against production (`~/apps/trading-live/data/app.db`, read-only)
  showed `alpaca-news` and `alpaca-snapshot` both failing almost entirely on `HTTP 401`
  before 2026-06-30T10:01 UTC (a credential issue that self-resolved) and `alpaca-snapshot`
  additionally failing ~97% of the time afterward on `HTTP 400` — traced to the same
  hyphen/dot share-class symbol bug already fixed in the trading gateway, but present
  independently in `data-providers.ts`'s Alpaca snapshot/news providers and the
  news-streaming store, since those are separate code paths that never shared the fix.
- Reading `src/lib/strategy.ts`'s `executeProposal` and autonomous run-loop found that
  `updateProposalStatus(proposalId, "placed", ...)` was called unconditionally after a
  non-throwing `gateway.placeEquityOrder()` — it never checked `execution.state`, so a
  broker that returns HTTP 200 with a declined order (a real, documented behavior for both
  Alpaca and Robinhood) would be recorded locally as a successfully placed live order.
  This is the direct, broker-agnostic version of "can the app tell if an order was placed."
- Reading `src/lib/robinhood.ts`'s `placeEquityOrder` found `orderId: String(raw.id ??
  raw.order_id)` with no guard — `String(undefined)` silently produces the string
  `"undefined"`, which would then never match Robinhood's real order list during
  reconciliation, leaving a phantom "placed" order.
- The user asked for a broad, expert-researched capability plan across 5 brokers,
  including non-trading uses, order-status monitoring, and an MCP evaluation. This is
  exactly the class of task the Workflow tool is for (ultracode was on this session): 5
  parallel research agents, one per broker, produced structured findings; the Robinhood
  section is unusually strong because a *live* Robinhood MCP connector was already
  attached to this session, so its 43-tool surface was enumerated directly (ground truth)
  rather than researched.

## Files

- `src/lib/money.ts` — added `toAlpacaSymbol`/`fromAlpacaSymbol` (moved from `alpaca.ts`,
  which now re-exports them) so `data-providers.ts` and the stream workers can share them.
- `src/lib/alpaca.ts` — imports the shared helpers instead of defining them locally.
- `src/lib/data-providers.ts` — `AlpacaSnapshotEnrichmentProvider.enrich` and
  `AlpacaNewsEnrichmentProvider.enrich` now convert symbols to/from Alpaca's dot notation
  at the request/response boundary.
- `src/lib/streams/alpaca-trade-updates-stream.ts` — fill-event symbol normalized via
  `fromAlpacaSymbol` before being forwarded to `onBrokerFill`.
- `src/lib/streams/news-store.ts` — `recordStreamedArticle` now stores headlines keyed by
  our hyphenated internal symbol, not Alpaca's raw dot-notation symbol, so
  `getStreamedHeadlines` lookups (which use the internal format) actually match.
- `src/lib/broker-side.ts` — added `isRejectedOrCanceledState()`, the single
  broker-agnostic terminal-decline check (case-insensitive, covers `canceled`/`cancelled`).
- `src/lib/strategy.ts` — both order-placement call sites (`executeProposal` and the
  autonomous run-loop) now check `isRejectedOrCanceledState(execution.state)` before
  marking a proposal `"placed"`; a synchronous decline is recorded as
  `"rejected_by_broker"` with its own audit event and notification instead. The
  reconciliation sweep's inline `["cancelled","canceled","rejected","failed"]` array was
  replaced with the shared helper (also now case-insensitive, and additionally recognizes
  `"expired"`).
- `src/lib/robinhood.ts` — `placeEquityOrder` throws when the MCP response has no
  extractable order id, instead of fabricating the string `"undefined"`.
- `test/data-providers.test.ts` — regression tests for `AlpacaSnapshotEnrichmentProvider`
  and a new `AlpacaNewsEnrichmentProvider` describe block covering the symbol conversion.
- `test/news-store.test.ts` — new file; covers the dot→hyphen store-key fix plus existing
  staleness/dedup behavior.
- `test/broker-side.test.ts` — regression tests for `isRejectedOrCanceledState`.
- `test/robinhood-mcp.test.ts` — new `HttpMcpRobinhoodGateway.placeEquityOrder` describe
  block: throws on a missing order id, returns correctly on a well-formed response.
- `test/reconciliation-risk.test.ts` — added a mixed-case (`"Rejected"`) regression test
  proving the reconciliation sweep is now case-insensitive post-refactor.
- `test/order-confirmation-status.test.ts` — new file; end-to-end test driving the real
  `executeProposal` approval path through a mocked Alpaca SDK, proving a broker-declined
  order is recorded as `"rejected_by_broker"` (not `"placed"`) and an accepted order still
  records `"placed"` correctly. Uses a `broker/paper` (not `broker/live`) connected
  account deliberately, to exercise the real gateway code path without also having to
  satisfy the unrelated typed live-approval-confirmation gate. Both tests padded to 30s
  (`}, 30000)`) — this repo has a documented history of `executeProposal`-driving tests
  flaking under full-suite parallel load (see `approval-lock.test.ts`'s existing 20s
  padding and CLAUDE.md's note on the same class of flake); confirmed this was a load
  artifact, not a logic bug, by re-running in isolation both before and after the machine's
  load average dropped from ~140 to ~90.
- `docs/broker-capability-plan.md` — new; the full audit + 5-broker capability research +
  MCP evaluation + prioritized roadmap.
- `docs/alpaca-mcp-vs-api-evaluation.md` — added an update section distinguishing the two
  different "MCP" scenarios this codebase touches (external chat client bypassing the app,
  vs. this app's own backend using MCP as a transport, which is fully safety-gated) and
  pointing to the new capability-plan doc for the full cross-broker picture.
- `STATUS.md`, `PLAN.md` — updated per the handoff protocol.

## Verification

- `npm run lint` — 0 errors, 254 pre-existing warnings (unchanged baseline).
- `npx tsc --noEmit` — clean.
- `npm test` — full suite green (166 files / 1598+ tests) after padding the two new
  `executeProposal`-driving tests to 30s; confirmed the timeout was a full-suite
  parallel-load artifact (machine load average was ~140 from many concurrent
  Claude Code/pm2 worktree processes plus this session's own research workflow), not a
  logic bug, by re-running the isolated file cleanly both before and after load dropped.
- `npm run build` — pending final run before merge (run it before landing).

## 2026-07-01 — PR #284 review fixes

Codex review follow-up tightened three edges in the broker/share-class work:

- `src/lib/alpaca.ts`: `getEquityQuotes` canonicalizes requested share-class symbols to
  internal hyphen form for Alpaca calls, then returns alias entries for both the internal
  key (`BRK-B`) and any requested dot-form key (`BRK.B`) so caller lookups do not fall
  through to delayed fallback data.
- `src/lib/data-providers.ts`: `AlpacaNewsEnrichmentProvider` canonicalizes requested
  dot-form share-class symbols before matching Alpaca article tags, and returns the
  requested alias alongside the internal key.
- `src/lib/dashboard-feed.ts`: `order_rejected_by_broker` audit events now render as
  broker declines in the unified Activity feed instead of the generic manual-rejection
  copy.

Regression tests added in `test/order-confirmation-status.test.ts`,
`test/data-providers.test.ts`, and `test/dashboard-feed.test.ts`.

### Verification (this round)

- `npx vitest run test/order-confirmation-status.test.ts test/data-providers.test.ts test/dashboard-feed.test.ts` — 79 tests pass.
- `npx tsc --noEmit` — clean.

## Follow-ups

See `docs/broker-capability-plan.md` §10 for the full prioritized list. Highlights:

- Add `logApiHealth()` calls to the broker-gateway paths (`alpaca.ts`, `robinhood.ts`) so
  the admin connection-status page can show broker-connection health, not just
  enrichment-provider health — this is the most direct fix for the confusion behind the
  original user report.
- Decide (explicitly, not by default) whether to enable the three fully-built but
  currently-disabled Alpaca WebSocket streams (`STREAMS_ALPACA_NEWS_ENABLED`,
  `STREAMS_ALPACA_TRADE_UPDATES_ENABLED`, `STREAMS_ALPACA_PRICE_EVENTS_ENABLED` — none set
  in production today). Not flipped in this change since it's a production behavior/cost
  decision, not a bug fix.
- `alpha-vantage`, `twelvedata`, and `congress.trade` show 0 successes ever in production
  — free-tier rate limits (alpha-vantage/twelvedata) and a timeout/unreachable issue
  (congress.trade, a separate app). Not code bugs; not fixed here.
- Robinhood options support, eToro/Public.com integration, and IBKR integration are all
  real feature work with their own gating decisions (account-access approval, licensing,
  or operational commitment respectively) — scoped but intentionally not started here.
