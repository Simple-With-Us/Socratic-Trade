# Market Data MCP And Provider Evaluation

Date: 2026-06-24

This evaluates whether MCP should change how the app uses FMP, Alpha Vantage, and
candidate market-data vendors. No API keys or trial tokens are recorded here.

## Current App Baseline

The app's production data path is direct, typed, cached, and source-attributed:

- `src/lib/data-providers.ts` enriches scan rows through Alpaca snapshots/news,
  optional Webull unofficial quotes, Robinhood fundamentals, Fintech Studios,
  Finnhub, Alpha Vantage, FMP, then Yahoo Finance.
- `src/lib/history.ts` fetches daily OHLC through Massive, Tradier, Marketstack,
  Robinhood, Yahoo, then Stooq.
- `src/lib/market-signals/massive.ts` uses Massive grouped daily bars for
  full-market breadth, VWAP, and market-wide movers.
- `app/api/keys/route.ts` currently exposes keys for OpenAI, xAI, Finnhub, FMP,
  Alpha Vantage, Marketstack, Tradier, FRED, SEC User-Agent, and Massive.
- `resolveApiKeyWithSource(service, userId)` and the cache-scope helpers are the
  right place to preserve the shared/env-key versus user-key privacy boundary.

The important architecture rule is unchanged: direct REST/WebSocket integrations
belong in the autonomous hot path. MCP is better for interactive research,
provider discovery, deep-dive workflows, and prototyping. If an MCP source is
promoted into the app, it should feed a normalized server-side ingestion adapter
that writes cached, source-attributed data. The LLM should not free-form call
market-data MCP tools inside scheduled trading runs.

## Executive Recommendation

1. Keep direct APIs for production scan, scoring, history, and execution-adjacent
   quote data.
2. Use MCP as an advisory/developer surface for sources with official MCP servers:
   FMP, Alpha Vantage, Twelve Data, EODHD, Nasdaq Data Link,
   FinancialData.net, Trading Volatility, and Unusual Whales.
3. Do not add a generic Yahoo-backed MCP from MCP Market to production. The app
   already has Yahoo direct fallback, and a third-party Yahoo MCP adds trust and
   operational risk without a new signal class.
4. Add Tiingo as the first low-cost direct adapter if the current Tiingo key is
   active. Tiingo has no obvious first-party MCP, but its direct REST API is a
   good fit for EOD prices, IEX intraday, news, corporate actions, and possibly a
   cleaner price-history fallback than free Yahoo/Stooq.
5. Consider FinancialData.net or EODHD as lower-cost all-in-one replacements.
   Both have official MCP surfaces and broad coverage.
6. Add Trading Volatility or Unusual Whales only if the strategy needs options
   flow, gamma/skew, dark-pool, or unusual-activity signals. They are
   differentiated signals, not replacements for fundamentals or OHLC history.

## Provider Verdicts

| Provider | MCP status | Cost / plan notes | Best app use | Verdict |
|---|---|---:|---|---|
| FMP | Official MCP | Free Basic: 250 calls/day. Starter: $22/mo billed annually. Premium: $59/mo. Ultimate: $149/mo. | Fundamentals, ratios, analyst grades, senate/insider paid endpoints. | Keep direct API. MCP useful for ad-hoc research and provider exploration, not hot path. |
| Alpha Vantage | Official MCP | Free standard limit is 25 requests/day. Premium starts at $49.99/mo for 75 requests/min and no daily cap. | News sentiment, indicators, macro/FX/crypto experiments. | Keep as supplemental sentiment only unless paid. MCP is convenient, but quota is too tight for scan loops. |
| Twelve Data | Official MCP | Basic free: 8 API credits/min and 800/day. Grow starts $29/mo; Pro $99/mo. | Technical indicators, global stocks, forex/crypto, WebSocket experiments. | Strong low-cost candidate for direct technical/indicator adapter. MCP good for Strategy Studio deep dives. |
| Tiingo | Community MCP only found | $30/mo individual, $50/mo internal commercial; free and paid API tiers exist. | EOD, IEX intraday, news, corporate actions, fundamentals add-on. | Add direct adapter first. Do not rely on community MCP for production. |
| EODHD | Official MCP | Free limited plan; paid plans start around $19.99/mo. MCP consumes normal API credits. | EOD/global prices, fundamentals, technical indicators, macro, logos, CBOE/UST, options EOD. | Strong cheaper all-in-one backup candidate. Test direct API for history/fundamentals before replacing FMP/Yahoo. |
| FinancialData.net | Official MCP | Free: 300 req/day. Standard $19/mo. Premium $49/mo. Professional $99/mo includes MCP/internal commercial. Enterprise $199/mo includes display/redistribution. | Fundamentals, real-time, intraday, insider, institutional, ETF, ESG, broad reference data. | Very attractive price/coverage. Worth trialing if external display licensing matters. |
| Nasdaq Data Link | Official MCP | Licensed-data surface; free trial/contact flow. | Licensed Nasdaq/economic/alternative datasets, institutional subscriptions. | Advisory/research only unless a specific subscribed Nasdaq dataset fills a gap. |
| mcpmarket stock-price | Third-party Yahoo MCP | No clear direct cost; depends on server trust. | Quick ad-hoc quote lookup. | Do not use in-app. Duplicates Yahoo fallback with worse provenance/control. |
| Tastytrade | Community MCPs; official API | Brokerage API and DXLink quote token; data charges may apply by account/professional status. | Options chains/IV, account-level research, possible future broker support. | Do not use MCP for autonomous execution. Direct read-only broker integration can be considered later. |
| Pyth | Official Pyth Pro MCP/plugin exists; community MCPs also exist | Pyth Pro pricing shows $2,500/mo starting for all real-time feeds; public/oracle access differs by use. | Oracle-like latest prices, crypto/FX/equity reference, on-chain parity. | Too expensive and not a general equity data replacement. Use only for crypto/oracle-specific research. |
| Databento | Community MCPs; official APIs/libs | Usage-based per GB; no monthly subscription according to pricing FAQ. | High-fidelity futures, options, equities tick/order-book/backtests. | Specialized backtest/feed source. Great for microstructure, not replacement for fundamentals/sentiment. |
| Unusual Whales | Official public API and MCP URL | API trial/basic/advanced: public page shows roughly $50/week trial, $150/mo basic, $375/mo advanced. | Options flow, dark pool, congressional/insider-style alternative data. | Differentiated signal source. Only add if options-flow features become part of scoring. |
| Trading Volatility | Official API and MCP | Subscriber API; 60 calls/min and 1,000,000 calls/month; price not exposed in captured text. | Gamma exposure, skew, call pressure, dark pool, dealer-positioning context. | High-signal options overlay. Good candidate for Strategy Studio and later scoring factor, not core price data. |

## Implementation Order If We Proceed

1. Add `tiingo` to `API_KEY_ENV_MAP`, aliases, tier map, and the Settings ->
   Connections catalog.
2. Add direct REST adapters:
   - `TiingoHistoryProvider` in `history.ts` before Yahoo/Stooq.
   - `TiingoEnrichmentProvider` for news/corporate actions if the key has access.
3. Add provider probes under admin-only routes that return field coverage,
   timestamps, entitlement errors, and response-shape samples with secrets redacted.
4. Add provenance labels in `src/lib/dashboard-ui.ts` and source ordering tests.
5. Keep MCP integration optional and out-of-hot-path:
   - Use provider MCPs from Claude/Codex/Cursor for research and codegen.
   - If app-side MCP is desired, build a narrow internal MCP client that calls
     read-only tools and stores normalized results through the same cache path.

## Sources Checked

- FMP MCP and pricing:
  https://site.financialmodelingprep.com/developer/docs/mcp-server
  https://site.financialmodelingprep.com/developer/docs/pricing
- Alpha Vantage MCP and pricing:
  https://mcp.alphavantage.co/
  https://www.alphavantage.co/premium/
- Twelve Data MCP and pricing:
  https://github.com/twelvedata/mcp
  https://twelvedata.com/pricing
  https://support.twelvedata.com/en/articles/5615854-credits
- Tiingo pricing/docs:
  https://www.tiingo.com/about/pricing
  https://www.tiingo.com/documentation/
  https://www.tiingo.com/products/end-of-day-stock-price-data
- EODHD MCP and EOD docs:
  https://eodhd.com/financial-apis/mcp-server-for-financial-data-by-eodhd
  https://eodhd.com/financial-apis/api-for-historical-data-and-volumes
- FinancialData.net:
  https://financialdata.net/
  https://financialdata.net/pricing
  https://financialdata.net/mcp-server
- Nasdaq Data Link MCP:
  https://www.nasdaq.com/solutions/data/nasdaq-data-link/api
- Trading Volatility:
  https://stocks.tradingvolatility.net/api/v2/docs
  https://stocks.tradingvolatility.net/capabilities
  https://stocks.tradingvolatility.net/subscribe
- Unusual Whales:
  https://unusualwhales.com/public-api
  https://unusualwhales.com/pricing
- Tastytrade:
  https://tastytrade.com/api/
  https://developer.tastytrade.com/streaming-market-data/
- Pyth:
  https://www.pyth.network/price-feeds
  https://www.pyth.network/blog/pyth-pro-for-ai-agents-institutional-market-data-for-autonomous-finance
- Databento:
  https://databento.com/
  https://databento.com/docs/faqs/usage-pricing-and-data-credits
  https://databento.com/stocks
- Generic MCP Market Yahoo quote server:
  https://mcpmarket.com/server/stock-price
