# 2026-06-20 — Broker honesty redesign (Test / Paper / Live; MCP-only Robinhood)

**Status:** IMPLEMENTED on `agent/claude` — `npx tsc --noEmit` clean, `npm test`
252/252 pass, `npm run build` succeeds. Pending merge to `main` + deploy to `trading-live`.

**Implemented notes:**
- Default broker for new users = `"test"` (decided).
- Alpaca paper-vs-brokerage is now derived from the **API key prefix** (`PK…` = Paper /
  paper-api, `AK…` = Brokerage / live api) in `app/api/connected-accounts/route.ts` — the
  prefix is authoritative and overrides the button, matching Alpaca's own "verify Paper vs
  Live from the keys" flow.
- The pervasive `Mock/Local` / `mock/local` vocabulary was renamed to `Test` / `test/local`
  across src, app, and tests (dashboard-feed, dashboard-ui, strategy, strategy-tuning,
  execution-mode, red-team, post-mortem, views, components, dashboard-client, settings + the
  matching test expectations).
- `MockRobinhoodGateway` → `TestBrokerGateway` (real Yahoo quotes + simulated fills, empty
  positions, account labeled "Test"); `getRobinhoodGateway()` is MCP-only; broker selection
  adds a `"test"` path; connect route syncs only the agentic Robinhood account.

## Why
Robinhood MCP now connects in prod (root cause was the redirect URI — see memory
`robinhood-mcp-oauth-prod`: it needs a `http://localhost` loopback redirect, not the
public Cloudflare-fronted `.services` URL). This is the follow-on cleanup so the app
stops "pretending": no fake Robinhood, no fake "paper Robinhood", honest broker labels.

## Decisions (terminology + behavior)
- **Test** = local simulation: REAL market quotes (Yahoo) + simulated fills, clean/empty
  positions, account honestly labeled **"Test"**. Short-term "kick the tires" mode. This is
  the renamed/cleaned `MockRobinhoodGateway` (which already fetched real Yahoo quotes — only
  its seeded account/positions and `mock-robinhood`/`{mock:true}` markers were fake).
- **Paper** = **Alpaca's real paper account** (paper-api.alpaca.markets, ~$100k from Alpaca).
  The app does NOT fake money — it just trades the Alpaca paper broker and labels it "Paper".
- **Live** = real money (Alpaca brokerage / Robinhood agentic).
- **Robinhood = MCP-only**; never a mock fallback. Not-connected → empty + "Connect Robinhood",
  never fabricated numbers.
- **Robinhood connect syncs ONLY the agentic account** (the one with `agenticAllowed:true` /
  read+write; e.g. 713670347). Investing/Roth IRA are read-only and skipped — this app is not a
  net-worth dashboard.
- The **only** gateway that simulates fills app-side is **Test**. Every real broker (incl.
  Alpaca paper) does its own fills.

## Connect UI — three explicit buttons (use the brokers' own words)
1. **Connect Robinhood Agentic Account** → OAuth/MCP `/api/auth/robinhood/start`; on return,
   sync the agentic account into `connected_accounts`. Hidden once a Robinhood account exists.
2. **Connect Alpaca Paper Account** → form for **paper** API keys → `paper-api.alpaca.markets`.
3. **Connect Alpaca Brokerage Account** → form for **live** API keys → `api.alpaca.markets`.
(Plus a "Test" account available without any broker.)

## File-by-file plan
- `src/lib/types.ts` — `ConnectedAccount.broker` and `TradingPolicy.activeBroker` →
  `"alpaca" | "robinhood" | "test"`. `RobinhoodMcpHealth.adapter` → `"mcp"` (drop `"mock"`).
- `src/lib/db.ts` — two `broker` casts (1665/1683) → include `"test"`.
- `src/lib/defaults.ts` — keep `activeBroker` default (or `"test"` for fresh installs — TBD).
- `src/lib/broker.ts` — add `if (activeBroker === "test") return getTestGateway()`; Robinhood
  path returns the MCP gateway (no mock).
- `src/lib/robinhood.ts` — `getRobinhoodGateway()` MCP-only; rename `MockRobinhoodGateway`
  → `TestBrokerGateway` (account `{TEST, "Test", agenticAllowed:true}`, positions `[]`,
  provider `"test"`/`"yahoo-finance"`, `raw:{test:true}`, `test-${refId}`); export
  `getTestGateway()`; health: drop `"mock"` wording → honest "not connected".
- `src/lib/alpaca.ts` — label account by environment ("Alpaca Paper" vs "Alpaca Brokerage");
  keys per connected account; paper↔live already routes via the SDK `paper:` flag.
- `app/api/connected-accounts/route.ts` — accept `broker: "test"`; add Robinhood agentic-sync
  (pull `get_accounts`, upsert the `agenticAllowed` one) on connect/return.
- `app/dashboard-client.tsx` + `app/ui/dashboard/settings.tsx` — three labeled connect buttons;
  hide Robinhood-connect once connected; drop `health.adapter === "mock"` branches → "not
  connected" state; remove the "paper" environment option for Robinhood (Alpaca keeps paper/live).
- `app/dashboard-types.ts` — `adapter?: "mcp"`.
- Tests — `performance.test.ts` (`provider:"mock-robinhood"` → `"test"`), `persistence-notification.test.ts`
  (`RH-MOCK-AGENT` → `TEST`), `robinhood-mcp.test.ts` (unaffected; keep).

## Verify + deploy
`npx tsc --noEmit` → `npm test` → `npm run build` on `agent/claude`; then merge to `main`
and deploy via `~/apps/trading-publish.sh`. Keep `policy.paperMode` strategy-sim untouched.

## Open decision
Default broker for a brand-new user with nothing connected: `"test"` (so the app is usable
immediately and honest) vs keep `"robinhood"` (errors until connected). Leaning `"test"`.
