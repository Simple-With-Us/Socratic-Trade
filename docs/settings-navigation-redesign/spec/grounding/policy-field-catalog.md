## Complete Trading Configuration Field Catalog

### USER_LEVEL_POLICY_FIELDS (Cross-Account User Preferences)

Per `/home/user/agentic-trading/src/lib/db-profiles.ts:20-24`, these three fields are stored in `user_settings.policy` and overlaid on every account read:

| Field Name | Line Reference |
|---|---|
| `notificationSettings` | db-profiles.ts:21 |
| `marketScanCandidateLimit` | db-profiles.ts:22 |
| `marketScanOutlierReserve` | db-profiles.ts:23 |

---

### TradingPolicy — Root Configuration

**Scope**: Account-level (stored in `account_strategy_state`) EXCEPT the 3 USER_LEVEL_POLICY_FIELDS above

| Dotted Path | TypeScript Type | Enum Options | Default Value | Scope |
|---|---|---|---|---|
| `systemState` | `SystemState` | `"active" \| "halted" \| "close_only" \| "liquidating"` | `"halted"` | account |
| `paperMode` | `boolean` | — | `false` | account |
| `paperStartingCash` | `number` | — | `10000` | account |
| `accountNumber` | `string \| undefined` | — | `undefined` | account |
| `connectedAccountId` | `string \| undefined` | — | `undefined` | account |
| `includedIndices` | `IndexUniverse[]` | `"sp100" \| "sp500" \| "nasdaq100" \| "nasdaqComposite" \| "dow30" \| "russell2000" \| "nyseComposite" \| "ftWilshire5000"` | `["sp500"]` | account |
| `additionalSymbols` | `string[]` | — | `[]` | account |
| `blocklist` | `string[] \| undefined` | — | `undefined` | account |
| `universeFloor` | `UniverseFloor \| undefined` | — | `{ minPrice: 5, minMarketCapUsd: 100_000_000, minDollarVolume: 1_000_000 }` | account |
| `strategyAuthority` | `StrategyAuthority` | `"propose" \| "decide"` | `"propose"` | account |
| `sellToFundBuy` | `SellToFundBuyMode \| undefined` | `"off" \| "suggest" \| "propose" \| "automated"` | `"off"` | account |
| `llmModel` | `string \| undefined` | — | `"gpt-5.4-mini"` | account |
| `redTeamLlmModel` | `string \| undefined` | — | `undefined` (reuses `llmModel` when unset) | account |
| `llmReasoningEffort` | `LlmReasoningEffort \| undefined` | `"low" \| "medium" \| "high"` | `"medium"` | account |
| `holdingHorizon` | `HoldingHorizon \| undefined` | `"intraday" \| "swing" \| "position" \| "longterm"` | `"swing"` | account |
| `maxOrderNotional` | `number \| undefined` | — | `undefined` | account |
| `maxOrderPctOfNav` | `number \| undefined` | — | `5` | account |
| `maxDailyNotional` | `number \| undefined` | — | `500` | account |
| `maxHourlyNotional` | `number \| undefined` | — | `undefined` | account |
| `allowExtendedHoursSyntheticStops` | `boolean \| undefined` | — | `false` | account |
| `maxDailyPctOfNav` | `number \| undefined` | — | `undefined` | account |
| `maxSymbolExposurePct` | `number \| undefined` | — | `25` | account |
| `maxSymbolExposureNotional` | `number \| undefined` | — | `undefined` | account |
| `maxGrossExposurePct` | `number \| undefined` | — | `80` | account |
| `maxNetExposurePct` | `number \| undefined` | — | `80` | account |
| `maxDailyOrders` | `number` | — | `10` | account |
| `maxProposalsPerRun` | `number` | — | `3` | account |
| `marketScanCandidateLimit` | `number \| undefined` | — | `30` (DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT) | **user** |
| `marketScanOutlierReserve` | `number \| undefined` | — | `8` (DEFAULT_MARKET_SCAN_OUTLIER_RESERVE) | **user** |
| `proposalExpiryMinutes` | `number \| undefined` | — | `2880` | account |
| `proposalRevalidateCadenceHours` | `number \| undefined` | — | `0` | account |
| `staleLimitOrderMinutes` | `number \| undefined` | — | `15` | account |
| `permittedOrderTypes` | `OrderType[]` | `"market" \| "limit" \| "stop_market" \| "stop_limit"` | `["market", "limit"]` | account |
| `permitExtendedHours` | `boolean` | — | `false` | account |
| `runCadenceMinutes` | `number` | — | `60` | account |
| `runDuringExtendedHours` | `boolean` | — | `false` | account |
| `scoringWeights` | `ScoringWeights` | (see ScoringWeights below) | (see ScoringWeights below) | account |
| `sectorCaps` | `Record<string, number>` | — | `{}` | account |
| `riskRules` | `RiskRules` | (see RiskRules below) | (see RiskRules below) | account |
| `notificationSettings` | `NotificationSettings` | (see NotificationSettings below) | (see NotificationSettings below) | **user** |
| `taxSettings` | `TaxSettings \| undefined` | (see TaxSettings below) | (see TaxSettings below) | account |
| `tuning` | `TuningSettings \| undefined` | — | `undefined` | account |
| `activeProfileId` | `string \| undefined` | — | `undefined` | account |
| `activeBroker` | `"alpaca" \| "alpaca-mcp" \| "robinhood" \| "test" \| undefined` | — | `undefined` (set from connected account) | account |
| `shortSellingEnabled` | `boolean \| undefined` | — | `undefined` | account |
| `maxShortOrderNotional` | `number \| undefined` | — | `undefined` | account |
| `maxShortExposurePct` | `number \| undefined` | — | `undefined` | account |
| `maxPortfolioBeta` | `number \| undefined` | — | `undefined` | account |
| `maxAvgCorrelation` | `number \| undefined` | — | `undefined` | account |
| `maxEntryDriftPct` | `number \| undefined` | — | `10` | account |
| `brokerBracketsEnabled` | `boolean \| undefined` | — | `true` | account |
| `robinhoodBrokerStops` | `boolean \| undefined` | — | `false` | account |
| `betaScaledStops` | `boolean \| undefined` | — | `undefined` | account |
| `atrStops` | `boolean \| undefined` | — | `undefined` | account |
| `marketableLimitEntries` | `boolean \| undefined` | — | `undefined` | account |
| `maxOrderPctOfAdv` | `number \| undefined` | — | `5` | account |
| `volPanicBrakeEnabled` | `boolean \| undefined` | — | `true` | account |
| `volPanicVixThreshold` | `number \| undefined` | — | `40` | account |
| `volPanicVvixThreshold` | `number \| undefined` | — | `150` | account |
| `volPanicSkewThreshold` | `number \| undefined` | — | `160` | account |
| `maxQuoteAgeSec` | `number \| undefined` | — | `undefined` (disabled) | account |
| `maxFundamentalsAgeSec` | `number \| undefined` | — | `undefined` (disabled) | account |

---

### RiskRules (nested in TradingPolicy.riskRules)

**Scope**: account-level

| Dotted Path | TypeScript Type | Enum Options | Default Value | Notes |
|---|---|---|---|---|
| `riskRules.stopLossPct` | `number \| undefined` | — | `8` | Per-position % loss limit |
| `riskRules.stopLossNotional` | `number \| undefined` | — | `undefined` | Per-position $ loss limit |
| `riskRules.takeProfitPct` | `number \| undefined` | — | `20` | Per-position % gain target |
| `riskRules.takeProfitTrimPct` | `number \| undefined` | — | `50` | % of position to sell at target (1–100) |
| `riskRules.takeProfitNotional` | `number \| undefined` | — | `undefined` | Per-position $ gain target |
| `riskRules.trailingStopPct` | `number \| undefined` | — | `0` | Trailing stop distance |
| `riskRules.shortStopLossPct` | `number \| undefined` | — | `8` (`DEFAULT_RISK_RULES`) | Hard stop on short positions (required for shorts; gate is auto-satisfied by the default) |
| `riskRules.atrStopPeriod` | `number \| undefined` | — | `undefined` | ATR lookback bars for volatility-aware stops (default 14) |
| `riskRules.atrStopMultiple` | `number \| undefined` | — | `undefined` | ATR multiplier for stop distance (default 2.0) |
| `riskRules.maxDrawdownPct` | `number \| undefined` | — | `undefined` | Account-level max drawdown from high-water mark; triggers close_only |
| `riskRules.maxDailyLossNotional` | `number \| undefined` | — | `undefined` | Account-level max single-day $ loss; triggers close_only |

---

### ScoringWeights (nested in TradingPolicy.scoringWeights)

**Scope**: account-level

| Dotted Path | TypeScript Type | Enum Options | Default Value | Notes |
|---|---|---|---|---|
| `scoringWeights.liquidity` | `number` | — | `1.4` | Volume/bid-ask spread factor |
| `scoringWeights.momentum` | `number` | — | `1.2` | Intraday & technical trend |
| `scoringWeights.value` | `number` | — | `0.8` | P/E, dividend yield, PEG |
| `scoringWeights.quality` | `number` | — | `0.8` | Debt/equity, earnings stability |
| `scoringWeights.volatility` | `number` | — | `0.8` | Beta, ATR, Sharpe-like metrics |
| `scoringWeights.sentiment` | `number` | — | `0.6` | News sentiment, analyst ratings |
| `scoringWeights.positioning` | `number` | — | `0.8` | Congressional trades, insider buying, short squeezes |
| `scoringWeights.diversification` | `number` | — | `1` | Sector/correlation diversity bonus |

---

### TaxSettings (nested in TradingPolicy.taxSettings)

**Scope**: account-level

| Dotted Path | TypeScript Type | Enum Options | Default Value | Notes |
|---|---|---|---|---|
| `taxSettings.taxationType` | `TaxationType \| undefined` | `"taxable" \| "roth_ira" \| "traditional_ira"` | `undefined` (defaults to "taxable" in mergePolicy) | Account structure / tax regime |
| `taxSettings.washSaleGuard` | `boolean` | — | `true` | IRC §1091: block rebuys within 30 days of loss |
| `taxSettings.shortTermRatePct` | `number` | — | `24` | Marginal tax rate on short-term gains (%) |
| `taxSettings.longTermRatePct` | `number` | — | `15` | Marginal tax rate on long-term gains (%) |
| `taxSettings.subtractFromResults` | `boolean \| undefined` | — | `undefined` | Show Performance net of estimated tax burden |

---

### TuningSettings (nested in TradingPolicy.tuning)

**Scope**: account-level (optional, all fields individually optional)

| Dotted Path | TypeScript Type | Enum Options | Default Value | Notes |
|---|---|---|---|---|
| `tuning.shrinkPrior` | `number \| undefined` | — | `5` | Bayesian shrinkage pseudo-count (weight learning) |
| `tuning.minClosedLotsForWeightShift` | `number \| undefined` | — | `20` | Min closed lots before auto-tuner shifts weights |
| `tuning.sizingFloorPct` | `number \| undefined` | — | `10` | Min % of max order notional for sizing |
| `tuning.sizingCeilingPct` | `number \| undefined` | — | `100` | Max % of max order notional for sizing |
| `tuning.redTeamConvictionThreshold` | `number \| undefined` | — | `80` | Confidence score threshold for Red Team review |
| `tuning.crisisMaxOpeningExposurePct` | `number \| undefined` | — | `undefined` (disabled) | Cap opening exposure in crisis/inverted regime |
| `tuning.convictionCapUncorroborated` | `number \| undefined` | — | `0.6` | Max upside conviction can contribute when edge unproven |
| `tuning.corroborationWinRatePct` | `number \| undefined` | — | `58` | Shrunk win rate threshold for edge corroboration |
| `tuning.corroborationEdgePct` | `number \| undefined` | — | `0` | Shrunk avg return threshold for edge corroboration |
| `tuning.bearVetoFcfYieldFloorPct` | `number \| undefined` | — | `undefined` (disabled) | Hard veto: FCF yield below this floor (%) |
| `tuning.bearVetoDebtToEquityCeiling` | `number \| undefined` | — | `undefined` (disabled) | Hard veto: debt/equity above this ceiling |
| `tuning.marketableLimitBufferBps` | `number \| undefined` | — | `15` | Basis points to price through quote on marketable limits |
| `tuning.skipNegativeExpectancy` | `boolean \| undefined` | — | `undefined` (disabled) | OPTIONAL gate: skip proven money-losers on opening |
| `tuning.skipNegativeExpectancyEdgePct` | `number \| undefined` | — | `0` | Edge threshold (%) for skipNegativeExpectancy |
| `tuning.oosWithholdUnvalidated` | `boolean \| undefined` | — | `true` | Withhold factor-weight changes when OOS validation fails |
| `tuning.useEntryRunAttribution` | `boolean \| undefined` | — | `false` | Surface per-run entry-credit P&L in tuner context |
| `tuning.minProposalScoreThreshold` | `number \| undefined` | — | `0` | Min scan score (0–100) to send to LLM |

---

### UniverseFloor (nested in TradingPolicy.universeFloor)

**Scope**: account-level (optional, applied only to SCANNED candidates, not explicit symbols or held positions)

| Dotted Path | TypeScript Type | Enum Options | Default Value | Notes |
|---|---|---|---|---|
| `universeFloor.minPrice` | `number \| undefined` | — | `5` | Minimum share price (penny-stock gate) |
| `universeFloor.minMarketCapUsd` | `number \| undefined` | — | `100_000_000` | Minimum market cap (applied only when known) |
| `universeFloor.minDollarVolume` | `number \| undefined` | — | `1_000_000` | Minimum daily $ volume = price × volume (applied only when known) |

---

### NotificationSettings (nested in TradingPolicy.notificationSettings)

**Scope**: User-level (in USER_LEVEL_POLICY_FIELDS)

| Dotted Path | TypeScript Type | Enum Options | Default Value | Notes |
|---|---|---|---|---|
| `notificationSettings.webhookUrl` | `string \| undefined` | — | `""` | Webhook endpoint for notifications |
| `notificationSettings.enabledEvents` | `NotificationEventType[]` | `"fill" \| "block" \| "run_failed" \| "pending_approval" \| "kill_switch" \| "price_alert" \| "proposal_withdrawn" \| "limit_order_stale" \| "provider_degraded"` | All events enabled (see types.ts:30-40) | Event types to send |

---

### ConnectedAccount Shape

**Scope**: Per broker/venue connection (stored in `connected_accounts` table)

| Field Name | TypeScript Type | Enum Options | Default Value | Notes |
|---|---|---|---|---|
| `id` | `string` | — | UUID (generated) | Primary key |
| `userId` | `string` | — | — | Foreign key to user |
| `broker` | `"alpaca" \| "alpaca-mcp" \| "robinhood" \| "test"` | — | — | Broker identifier |
| `environment` | `"paper" \| "live"` | — | — | Paper or live trading |
| `taxationType` | `TaxationType \| undefined` | `"taxable" \| "roth_ira" \| "traditional_ira"` | `undefined` | DEPRECATED (use capabilities.accountType) |
| `accountNumber` | `string \| undefined` | — | — | Broker's account ID |
| `label` | `string` | — | — | User-friendly display name |
| `apiKey` | `string \| undefined` | — | — | OAuth/API credential (encrypted in DB) |
| `apiSecret` | `string \| undefined` | — | — | OAuth/API secret (encrypted in DB) |
| `baseUrl` | `string \| undefined` | — | — | Broker gateway endpoint override |
| `isActive` | `boolean` | — | — | Set as primary account for runs |
| `capabilities` | `AccountCapabilities \| undefined` | — | `undefined` (legacy rows) | Broker-reported account capabilities snapshot |
| `createdAt` | `string` | — | ISO 8601 timestamp | Creation time |
| `updatedAt` | `string` | — | ISO 8601 timestamp | Last update time |

---

### AccountCapabilities Shape (nested in ConnectedAccount.capabilities)

**Scope**: Persisted snapshot from broker on connect/re-sync

| Field Name | TypeScript Type | Enum Options | Default Value (absent/legacy) | Notes |
|---|---|---|---|---|
| `equityTrading` | `boolean` | — | `false` | Stock/ETF trading |
| `shortSelling` | `boolean` | — | `false` | Equity short selling (borrow & sell) |
| `optionsTrading` | `boolean` | — | `false` | Options contracts |
| `optionsLevel` | `0 \| 1 \| 2 \| 3 \| 4 \| undefined` | — | `undefined` | CBOE options approval tier (0=none, 4=naked) |
| `futuresTrading` | `boolean` | — | `false` | Futures/commodities |
| `cryptoTrading` | `boolean` | — | `false` | Crypto spot trading |
| `marginEnabled` | `boolean` | — | `false` | Margin/borrowing available |
| `marginRequirementPct` | `number \| undefined` | — | `undefined` | Maintenance margin % (e.g., 25) |
| `accountType` | `"brokerage" \| "traditional_ira" \| "roth_ira" \| "crypto_exchange"` | — | (from taxationType if absent) | Account structure / tax regime |

---

### StrategyProfile Shape

**Scope**: User library profile (stored in `strategy_profiles` table)

| Field Name | TypeScript Type | Enum Options | Default Value | Notes |
|---|---|---|---|---|
| `id` | `string` | — | UUID (generated) | Primary key |
| `name` | `string` | — | — | Display name (e.g., "Conservative", "Aggressive") |
| `policy` | `TradingPolicy` | — | — | Embedded full trading policy (merged with defaults) |
| `prompt` | `string` | — | DEFAULT_STRATEGY_PROMPT | Strategy instruction text for LLM |
| `scoringWeights` | `ScoringWeights` | — | DEFAULT_SCORING_WEIGHTS | Factor weights (normalized copy) |
| `active` | `boolean` | — | `false` | One profile is marked active per user |
| `createdAt` | `string` | — | ISO 8601 timestamp | Creation time |
| `updatedAt` | `string` | — | ISO 8601 timestamp | Last update time |

---

## Notes on Policy Merging & Defaults

- **mergePolicy()** (db-profiles.ts:123–148): Merges a partial policy with `DEFAULT_POLICY`, then applies nested defaults for `riskRules`, `notificationSettings`, and `scoringWeights`.
  
- **normalizeScoringWeights()** (db-profiles.ts:150–157): Clamps all weight values to non-negative numbers; missing weights default to `DEFAULT_SCORING_WEIGHTS`.

- **User-level overlays**: On every `getPolicy()` read, user-level fields from `user_settings.policy` (notificationSettings, marketScanCandidateLimit, marketScanOutlierReserve) are merged on top of the account-level base policy.

- **Account-level seed**: Per-account state in `account_strategy_state` is lazily seeded on first read using the active library profile or legacy user_settings blob.

- **Legacy fields**: `dryRun` (→ `paperMode`), `llmModel`/`redTeamLlmModel`/`llmReasoningEffort` can migrate from user_settings to account-level when an account is created.

---

## Summary Table

| Aspect | Count | Notes |
|---|---|---|
| Top-level TradingPolicy fields | 62 | Excluding nested objects |
| Nested RiskRules fields | 10 | Inside policy.riskRules |
| Nested ScoringWeights fields | 8 | Inside policy.scoringWeights |
| Nested TaxSettings fields | 4 | Inside policy.taxSettings |
| Nested TuningSettings fields | 18 | Inside policy.tuning |
| Nested UniverseFloor fields | 3 | Inside policy.universeFloor |
| Nested NotificationSettings fields | 2 | Inside policy.notificationSettings |
| USER_LEVEL_POLICY_FIELDS | 3 | Cross-account preferences |
| ConnectedAccount fields | 13 | Per broker connection |
| AccountCapabilities fields | 8 | Broker capability snapshot |
| StrategyProfile fields | 8 | User library entry |
| **TOTAL (all fields)** | **145+** | Fields span types.ts, db-profiles.ts, defaults.ts |
