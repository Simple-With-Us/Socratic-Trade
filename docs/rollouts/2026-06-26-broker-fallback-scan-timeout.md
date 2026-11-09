# 2026-06-26 — Fix: broker fallback + scan timeout

## Summary

Two operator-reported bugs fixed: "Robinhood MCP HTTP 401" appearing in proposals without a
Robinhood account, and "Couldn't reach the scan service" on the Market Scan tab.

## Why

### Bug 1 — Broker fallback defaults to Robinhood

`getBrokerGateway` (`src/lib/broker.ts`) was structured as:
1. alpaca / alpaca-mcp → AlpacaGateway
2. test → TestGateway
3. *(everything else)* → RobinhoodGateway

The "everything else" path included `undefined` — which is the value of `activeBroker` when the
policy was never explicitly saved after a broker switch, or when the DB row predates the field.
Users who configured Alpaca but had an older policy record would silently get the Robinhood
gateway, which immediately returned HTTP 401 (no MCP token stored). That 401 was recorded in the
`error_message` column of `trade_proposals` and surfaced in the Proposals tab as
"Order error: Robinhood MCP HTTP 401: authentication required".

### Bug 2 — Scan route has no timeout

`scanMarket` fetches from Yahoo Finance, Nasdaq screener, Massive, FinnHub, and SEC EDGAR. When
Yahoo rate-limits (or any provider is slow), the Next.js route handler hangs waiting. Most
reverse-proxy setups (nginx, Cloudflare) have a ~30 s upstream timeout. When the timeout fires,
the proxy closes the TCP connection; the browser sees a network-level abort ("Failed to fetch" /
"Load failed" / "Aborted") rather than an HTTP response. The client maps these to "Couldn't reach
the scan service" — misleading because the service IS running; the scan just took too long.

## Files

- `src/lib/broker.ts` — make the Robinhood case explicit; all unrecognized/undefined values now
  fall through to the safe test gateway.
- `app/api/scan/route.ts` — wrap `scanMarket` in a 25 s `Promise.race` timeout so a hung
  provider returns a JSON 500 instead of a silent proxy abort.
- `STATUS.md` — updated.
- `docs/rollouts/2026-06-26-broker-fallback-scan-timeout.md` — this file.

## Follow-ups

- **Root cause of undefined activeBroker**: users whose policy predates explicit broker selection
  may have `activeBroker: undefined` in the DB. After this fix they get the test gateway (safe),
  but they should visit Settings → Connections and re-select their broker to set it explicitly.
- **Scan timeout value**: 25 s is conservative. If Yahoo rate-limits routinely (this host gets
  429s per CLAUDE.md notes), consider raising the scan cache TTL or adding a stale-while-revalidate
  pattern so cached results are served immediately while a background refresh runs.
- **Stale proposals with Robinhood errors**: any proposals already stored with
  `error_message: "Robinhood MCP HTTP 401..."` will still show in the Proposals tab until they
  expire. The underlying bug is fixed going forward; old rows are historical and can be cleared
  by an admin sweep if needed.

## Verification

```
npx tsc --noEmit   # clean
npm test           # 1257/1257 passed
npm run build      # clean
```
