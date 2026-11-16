# 2026-07-06: Fix API Health Timeouts for Voyage and Congress.Trade

- **Summary**: Resolved false-positive connection failure errors appearing in the Mobile Settings view for `voyage` and `congress.trade`.
- **Why**: 
  - `voyage` was showing simulated failures because `test/rag-retrieval-regression.test.ts` poisoned the live database during unit tests by not mocking `logApiHealth`.
  - `congress.trade` SSE endpoint was incorrectly logging failures during its reconnection loop despite being disabled when it lacked credentials.
  - `congress.trade` REST client was timing out (showing 30s delays and 8s AbortController aborts in the health logs) due to Node.js `undici` native `fetch` preferring IPv6 (`AAAA` records), causing it to blackhole on hosts with an IPv6 interface but no routing to Cloudflare IPv6 endpoints.
- **Files**:
  - `test/rag-retrieval-regression.test.ts` (Mocked `logApiHealth`)
  - `src/lib/congress-stream.ts` (Added credentials guard before reconnection loop)
  - `next.config.mjs` (Added `dns.setDefaultResultOrder("ipv4first");` to force Node to prefer IPv4).
- **Verification**: 
  - `npm run lint` && `npx tsc --noEmit` && `npm test`
  - Restarted `pm2 restart trading-main` and queried `api_health_log` to observe `latency_ms` dropping from >8000ms (timeout) to ~100ms.
  - NOTE: `npx tsc --noEmit` is currently failing on `main` due to unrelated type breakages in `ApiKeySource`/`LlmKeySource` introduced in a parallel session.
- **Follow-ups**: None.
