# Unified Architectural Blueprint: Core Trading Engine Extensions

This document establishes a target architectural blueprint, database schemas, type modifications, and reasoning prompt structures for the next-generation trading engine. It is a design plan for multi-tenant safety, tax-aware execution, trailing stop-losses, robust data pipelines, and prompt/reasoning optimizations.

**Implementation status:** this document is not a statement that every control already exists in runtime code. Sections below describe the desired architecture and should be implemented incrementally with tests, rollout notes, and status updates as each slice lands. As of 2026-06-20, the first runtime slice is live for tri-state execution derivation/labels, LLM-facing mode language, shared OpenAI output caps, and the RAG tenant-safety controls in Sections 4.1, 4.4.1, and part of 4.4.3. Runtime labels now use **Test**, **Paper**, and **Brokerage**: Test is the app's local simulator, Paper is an optional broker-hosted sandbox account a user chooses to connect, and Brokerage is a live broker production account. Pinecone metadata/query tenant IDs are sanitized, but Pinecone/Voyage API-key lookup still uses the raw app user ID.

> **Superseded note (2026-07-03):** This document's proposed design (a
> legacy paper-mode Tri-State model with a local Test simulator) was NOT the
> design that shipped. The actual removal (see
> `docs/rollouts/2026-07-03-remove-paper-default-test-mode.md`) deleted
> the legacy paper-mode policy and the local Test/simulator state entirely — execution
> mode is now derived purely from a connected account's `environment`
> (`broker/paper` or `broker/live`), with no connected account meaning the
> app simply cannot place orders. The rest of this document is left as a
> historical design record; do not use it as a guide to current behavior.

---

## 1. Decoupled Tri-State Execution Model

The core execution engine should be upgraded from a binary legacy paper-mode switch to a decoupled Tri-State Execution Model. This historical proposal separated the *strategy analysis* mode from the *broker-account environment*, enabling robust local simulation, sandbox broker validation, and live capital execution. It was superseded by the 2026-07-03 removal described above.

### 1.1 Derivation Logic

The target active execution state is resolved dynamically by combining the current `TradingPolicy` settings and the `ConnectedAccount` configuration:

```
                  ┌──────────────────────────────┐
                  │ removed legacy policy enabled │
                  └──────────────┬───────────────┘
                                 │ Yes
                                 ▼
                     ┌───────────────────────┐
                     │        TEST           │ (State 1: Local Simulator)
                     └───────────────────────┘
                                 │ No
                                 ▼
                 ┌───────────────────────────────┐
                 │ removed legacy policy disabled │
                 └──────────────┬────────────────┘
                                │
         ┌──────────────────────┴──────────────────────┐
         │ activeAccount.environment === "paper"       │ activeAccount.environment === "live"
         ▼                                             ▼
┌───────────────────┐                         ┌───────────────────┐
│       PAPER       │                         │     BROKERAGE     │
│ (State 2: Sandbox)│                         │ (State 3: Capital)│
└───────────────────┘                         └───────────────────┘
```

#### State Definitions
1. **Test (Local Simulator)**:
   - **Trigger**: removed legacy paper-mode policy enabled.
   - **Behavior**: All order processing, position tracking, and fills are handled by the local SQLite database state machine. Zero network calls are made to external broker execution endpoints.
2. **Paper (Broker Sandbox)**:
   - **Trigger**: removed legacy paper-mode policy disabled AND `activeAccount.environment === "paper"`.
   - **Behavior**: Orders are routed to the broker's sandbox/paper environment when the user has connected one (for example, Alpaca Paper). Account balance, buying power, and position queries are routed to that broker's paper endpoints.
3. **Brokerage (Live Capital)**:
   - **Trigger**: removed legacy paper-mode policy disabled AND `activeAccount.environment === "live"`.
   - **Behavior**: Orders are routed directly to the broker's live production API (e.g., Alpaca Live API or Robinhood MCP). Fills execute in real-time using real capital.

---

### 1.2 Custom Theme Styling Profiles

To prevent catastrophic operational mistakes (e.g., executing live trades thinking the dashboard is in mock mode), the UI dynamically swaps visual theme profiles based on the active execution state:

| Style Dimension | State 1: Test | State 2: Paper | State 3: Brokerage |
| :--- | :--- | :--- | :--- |
| **Theme Profile** | **Slate** | **Emerald/Teal** | **Amber/Red** |
| **Primary Text** | `text-slate-200` | `text-emerald-400` | `text-amber-500` / `text-red-400` |
| **Background Tint**| `bg-slate-950/50` | `bg-emerald-950/20` | `bg-red-950/30` |
| **Borders** | `border-slate-800` | `border-emerald-900/50` | `border-red-900` |
| **Visual Shadow** | `shadow-slate-500/5`| `shadow-emerald-500/10` | `shadow-red-500/20` |
| **Pulse Ring** | None | `ring-emerald-500/20` (slow) | `ring-red-500/40` (urgent, fast) |

#### Tailwind Implementation Snippet
```tsx
function getThemeClasses(state: "test" | "paper" | "live") {
  switch (state) {
    case "test":
      return "bg-slate-950/50 border-slate-800 text-slate-200 shadow-slate-500/5";
    case "paper":
      return "bg-emerald-950/20 border-emerald-900/50 text-emerald-400 shadow-emerald-500/10 ring-1 ring-emerald-500/20 animate-pulse";
    case "live":
      return "bg-red-950/30 border-red-900 text-amber-500 shadow-red-500/20 ring-2 ring-red-500/40 animate-pulse-fast";
  }
}
```

#### 1.2.1 Tailwind CSS Custom Animation Definition
To support the urgent pulse styling for State 3: Brokerage, custom keyframes and animation utility classes are configured in `app/globals.css`:

```css
@keyframes pulse-fast {
  0%, 100% {
    opacity: 1;
    box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7);
  }
  50% {
    opacity: 0.3;
    box-shadow: 0 0 0 8px rgba(239, 68, 68, 0);
  }
}

.animate-pulse-fast {
  animation: pulse-fast 1s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}
```

---

### 1.3 Warnings, Alerts, and Confirmation Tickets

#### Top-Bar Status Alerts
A persistent, full-width status bar should be displayed at the top of the screen:
- **Test**: `bg-slate-900 border-b border-slate-800 text-slate-400 text-xs text-center py-1.5`
  > "TEST MODE: Local simulation with simulated fills. Real capital is safe."
- **Paper**: `bg-emerald-950/80 border-b border-emerald-900 text-emerald-400 text-xs text-center py-1.5 font-medium`
  > "PAPER TRADING: Active broker sandbox. Executing broker-paper orders."
- **Brokerage**: `bg-red-950/90 border-b border-red-900 text-red-200 text-xs text-center py-1.5 font-bold animate-pulse`
  > "LIVE BROKERAGE: Real capital at risk. Executing live broker orders on [active broker]."

#### Live Order Confirmation Ticket Modal
When the system is in **Brokerage** state and a trade is proposed (or triggered via Autonomy loop), the user interface intercepts execution with a high-friction confirmation ticket:

1. **Trade Summary**: Displays target ticker, action (BUY/SELL/SHORT/COVER), proposed quantity, estimated notional cost, and the resulting portfolio exposure percentage.
2. **Dynamic Risk Check**: Displays real-time bids/asks and bid-ask spread in basis points (warns if spread exceeds 50 bps).
3. **Friction Mechanisms**:
   - **Explicit Disclaimer Checkbox**: Must be checked to enable the execution button:
     `[ ] I understand that I am placing a live trade with real capital and accept full financial responsibility.`
   - **Swipe/Slide to Confirm Slider**: A horizontal slider that the user must drag to the far right to trigger the API order dispatch. This eliminates fat-finger errors.

---

### 1.4 Autonomous Live Execution Security Gate

To protect live capital and prevent runaway algorithmic execution, a multi-layered security gate should be enforced whenever live capital is deployed in autonomous ("decide") mode.

#### 1.4.1 High-Friction UI Confirmation
- When transitioning a live brokerage account from "propose" (semi-autonomous) to "decide" (fully autonomous) mode, the user interface must display a persistent modal requiring two high-friction actions:
  1. An explicit checkbox confirmation agreeing to the live execution risks.
  2. A sliding confirmation widget (e.g., `SlideToConfirm`) that the user must drag to the right to commit the mode change.
- The state transition is blocked until both validation checks succeed.

#### 1.4.2 Default Safe Configuration
- All newly added live brokerage accounts default to "propose" (semi-autonomous) mode.
- Full autonomy ("decide") must be explicitly opted into using the high-friction confirmation gate.

#### 1.4.3 Strict Policy Notional Caps
- Live autonomous orders are subject to strict policy-level rate limits and notional caps:
  - **Hourly Notional Cap**: Maximum cumulative value of orders submitted within any rolling 60-minute window (e.g., $10,000).
  - **Daily Notional Cap**: Maximum cumulative value of orders submitted within any single trading day (e.g., $50,000).
- If any order would exceed these limits, the execution engine rejects the order, logs a policy violation to the audit logs, and automatically reverts the account to "propose" mode.

#### 1.4.4 Null/Undefined activeAccount Fallback
- If `activeAccount` is null, undefined, or missing, the system gracefully defaults execution to State 1: Test.
- In this fallback state, all real strategy execution and external order placement are strictly blocked, and the dashboard displays a clear warning message indicating the inactive broker state.

---

## 2. Trailing Stop-Loss Architecture

To protect capital against sudden drawdowns, the trading engine incorporates a trailing stop-loss subsystem capable of tracking peaks (for long positions) and troughs (for short positions).

### 2.1 Mathematical Model

Let:
- $t_0$ be the timestamp of position entry.
- $P_t$ be the asset price at time $t \ge t_0$.
- $H_t$ be the highest price achieved (peak) since entry (for long positions).
- $L_t$ be the lowest price achieved (trough) since entry (for short positions).
- $p$ be the percentage-based trailing parameter (e.g., $p = 5.0$ for a $5\%$ trail).
- $A$ be the absolute-based trailing parameter (e.g., $A = 2.0$ for a $\$2.00$ trail).
- $S_t$ be the calculated trailing stop trigger price.

#### 2.1.1 Long Positions (Peak Tracking)
The peak tracking variable $H_t$ is defined as:
$$H_t = \max_{t_0 \le \tau \le t} P_\tau \quad \text{with} \quad H_{t_0} = \text{entry\_price}$$

The stop trigger price $S_t$ is resolved at time $t$ by:
$$S_t = \max\left( S_{t-1}, \; \text{StopFormula}(H_t) \right)$$

Where:
- **Percentage Stop**: $S_t = H_t \times \left(1 - \frac{p}{100}\right)$
- **Absolute Stop**: $S_t = H_t - A$

*Trigger Condition*: If $P_t \le S_t$, trigger a market sell order immediately.

#### 2.1.2 Short Positions (Trough Tracking)
The trough tracking variable $L_t$ is defined as:
$$L_t = \min_{t_0 \le \tau \le t} P_\tau \quad \text{with} \quad L_{t_0} = \text{entry\_price}$$

The stop trigger price $S_t$ is resolved at time $t$ by:
$$S_t = \min\left( S_{t-1}, \; \text{StopFormula}(L_t) \right)$$

Where:
- **Percentage Stop**: $S_t = L_t \times \left(1 + \frac{p}{100}\right)$
- **Absolute Stop**: $S_t = L_t + A$

*Trigger Condition*: If $P_t \ge S_t$, trigger a market cover order immediately.

---

### 2.2 Native Delegation vs. Synthetic Local Tracking

The target system adopts a hybrid trailing stop strategy based on broker capability:

```
                            ┌────────────────────────┐
                            │   Analyze Order/Side   │
                            └───────────┬────────────┘
                                        │
                         ┌──────────────┴──────────────┐
                         ▼                             ▼
                 Alpaca Broker               Robinhood MCP (No Native Support)
         ┌───────────────────────────┐         ┌───────────────────────────┐
         │ Native Trailing Stop      │         │ Synthetic Local Stop      │
         │ - Register trail_pct/val  │         │ - Write to local database │
         │ - Delegated to broker API │         │ - Poll quote loop         │
         │ - 0ms execution latency   │         │ - Local trigger & execute │
         └───────────────────────────┘         └───────────────────────────┘
```

- **Native Delegation (Alpaca)**: Supported natively. Orders are submitted as `type: "trailing_stop"` with either `trail_percent` or `trail_price`. The broker handles high-frequency tracking and triggers execution server-side.
- **Synthetic Local Tracking (Robinhood MCP)**: Robinhood's MCP lacks native trailing stop orders. The system intercepts these orders, registers the parameters in the local SQLite database, and runs a background loop checking prices and executing triggers locally via market orders.

---

### 2.3 Database Schema

Synthetic stops are tracked in the SQLite database via the `synthetic_trailing_stops` table:

```sql
CREATE TABLE IF NOT EXISTS synthetic_trailing_stops (
    symbol TEXT NOT NULL,
    account_number TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('long', 'short')),
    entry_price REAL NOT NULL,
    extreme_price REAL NOT NULL, -- H_t (for long) or L_t (for short)
    trailing_stop_pct REAL,       -- e.g. 5.0 (5%)
    trailing_stop_abs REAL,       -- e.g. 2.0 ($2.00)
    updated_at TEXT NOT NULL,     -- ISO8601 Timestamp
    PRIMARY KEY (symbol, account_number)
);
```

---

### 2.4 Execution Check-Loop Logic

1. **Check Interval**: The background loop executes every **5 to 15 minutes** (controlled by the `SYNTHETIC_STOP_INTERVAL_SEC` environment variable).
2. **Latency & Slippage Modeling**:
   - Because quotes are checked periodically, execution is subject to latency.
   - Slippage is modeled for paper trading and projected in live execution limits:
     $$\text{Slippage} = \text{base\_slippage} + \beta \times \text{spread\_bps}$$
     - Normal market conditions: 10 bps (0.10%) base slippage.
     - Thin liquidity (volume < 500k shares daily): Up to 50 bps (0.50%) slippage.
3. **Extended-Hours Bounds**:
   - Synthetic trailing stops are active by default only during regular market hours (`9:30 AM - 4:00 PM EST`).
   - Toggling `allowExtendedHoursSyntheticStops` in policy allows extended hours checks. In this state, bid-ask spreads are checked, and triggers are bypassed if the bid-ask spread is wider than 2.0% of the asset's price to prevent false stop-outs.

---

### 2.5 Synthetic Stop Edge Case Mitigations

To prevent false stop-outs, stale execution, and improper adjustments, the synthetic trailing stop loop must implement five key mitigation safeguards:

#### 2.5.1 Corporate Actions Adjustment
When a stock split with split ratio $r$ (new shares / old shares) or a dividend distribution of $D$ per share occurs, the database values in `synthetic_trailing_stops` must be updated to prevent erroneous stops:
- **Stock Split**:
  - Adjusted entry price: $entry\_price_{new} = entry\_price_{old} / r$
  - Adjusted extreme price: $extreme\_price_{new} = extreme\_price_{old} / r$
  - Adjusted absolute trailing stop: $trailing\_stop\_abs_{new} = trailing\_stop\_abs_{old} / r$
- **Dividend Distribution**:
  - Adjusted entry price: $entry\_price_{new} = entry\_price_{old} - D$
  - Adjusted extreme price: $extreme\_price_{new} = extreme\_price_{old} - D$
  - Adjusted absolute trailing stop remains unchanged unless explicitly re-calculated.

#### 2.5.2 Outlier Quote Filtering
To prevent transient bad ticks, zero/null quotes, or flash crash spikes from triggering a stop-out:
- The system maintains a rolling window of the last 5 quotes.
- A new quote $P_t$ is filtered out (discarded) if:
  1. $P_t \le 0$ or is null/undefined.
  2. $P_t$ deviates from the 5-period simple moving average ($SMA_5$) by more than 10%, i.e., $\left| \frac{P_t - SMA_5}{SMA_5} \right| > 0.10$.
- **Exception**: The quote is accepted if it is verified by consecutive ticks (2 or more consecutive prints confirming the deviation) or cross-referenced and confirmed across multiple data sources (e.g., Finnhub and Yahoo Finance).

#### 2.5.3 Proximity-Based Polling Cadence
To reduce latency when an asset is close to triggering its trailing stop:
- The normal poll interval is 5 to 15 minutes.
- If the current price $P_t$ comes within $1.5\%$ of the stop trigger price $S_t$ (i.e., $\frac{|P_t - S_t|}{P_t} \le 0.015$), the polling cadence dynamically tightens to a high-frequency **10-second interval** until either the stop is triggered or the price bounces back outside the threshold.

#### 2.5.4 Stale Row Purge
- When a position size for a symbol drops to zero (due to a profit take, manually closing the position, or execution of a stop), the system must unconditionally delete the corresponding row from the `synthetic_trailing_stops` table.
- This ensures that if the strategy re-enters the position at a later date, a stale, low-stop price does not persist and cause an immediate false stop-out.

#### 2.5.5 Policy Gate Integration
- Emergency trailing stop exits bypass the normal strategy scanning cooldown timers to ensure prompt capital protection.
- All bypassed emergency exits are audited and stored in the database with their matching execution metadata.

---

## 3. Taxation Policy Settings (IRA Support)

To support retirement accounts (Traditional and Roth IRAs), the engine provides special taxation environments that override standard tax-mitigation guardrails.

### 3.1 Type Definitions

```typescript
export type TaxationType = "taxable" | "roth_ira" | "traditional_ira";

export interface ConnectedAccount {
  id: string;
  userId: string;
  broker: "alpaca" | "robinhood";
  environment: "paper" | "live";
  taxationType?: TaxationType; // Add taxationType support
  // ... other fields ...
}

export interface TaxSettings {
  washSaleGuard: boolean;
  shortTermRatePct: number;
  longTermRatePct: number;
  subtractFromResults?: boolean;
  taxationType?: TaxationType; // Plumbed into strategy policy
}
```

---

### 3.2 Resolution Rules for IRA Accounts

When an account is flagged as `"roth_ira"` or `"traditional_ira"`, the database layer and policy validators apply the following overrides to the active policy configuration:

```typescript
export function resolveTaxSettingsForAccount(
  settings: TaxSettings,
  taxationType: TaxationType
): TaxSettings {
  if (taxationType === "roth_ira" || taxationType === "traditional_ira") {
    return {
      ...settings,
      washSaleGuard: false,     // IRAs are exempt from wash-sale lockouts
      shortTermRatePct: 0,      // Tax-sheltered/deferred growth
      longTermRatePct: 0,       // Tax-sheltered/deferred growth
      taxationType
    };
  }
  return { ...settings, taxationType };
}
```

1. **Forced 0% Tax Rates**: All estimated liability indicators on the Performance dashboard and in LLM prompts are set to 0.
2. **Wash-Sale Bypass**: In taxable accounts, selling a stock at a loss and rebuying it within 30 days disallows the tax deduction. The agent blocks these rebuy attempts. For IRA accounts, this restriction is bypassed entirely (the wash-sale lock set in `getWashSaleLockedSymbols` returns an empty set).
3. **No tax-loss harvest**: Harvest candidates are empty, Green is not told this is a taxable account, and `harvestableLosses` / `positionsNearLongTerm` are omitted from `taxContext`. An IRA cannot deduct a realized loss.

---

### 3.3 Cross-Account Wash Sale Prevention

The IRS wash-sale rule (IRC Section 1091) prohibits claiming a tax loss on a security if a "substantially identical" security is purchased within 30 days before or after the sale. If a loss is realized in a taxable brokerage account and the security is purchased in an IRA (Roth or Traditional) within the 61-day window, the loss is disallowed and cannot be added to the IRA's basis (creating a permanent tax loss trap).

To mitigate this:
1. **User-Level Scope**: Wash-sale detection is evaluated at the `userId` level, spanning all connected accounts.
2. **Wash-Sale Lock**: A taxable-account loss can still appear as a user-level lock.  IRA Ignore (`disregard`, the default) does not constrain that IRA or Green.  IRA Auto proceeds and Green weighs the priced cost.  IRA Block refuses.  `washSaleMinLossUsd` is optional (blank = every loss).
3. **Validation Logic**:
   ```typescript
   export function checkCrossAccountWashSale(
     userId: string,
     symbol: string,
     recentSales: Array<{ accountId: string; symbol: string; soldAt: Date; wasLoss: boolean; accountTaxType: TaxationType }>
   ): boolean {
     // A wash-sale lock is triggered if the symbol was sold at a loss in any taxable account within the last 30 days
     return recentSales.some(
       (sale) =>
         sale.symbol === symbol &&
         sale.wasLoss &&
         sale.accountTaxType === "taxable" &&
         (Date.now() - sale.soldAt.getTime()) <= 30 * 24 * 60 * 60 * 1000
     );
   }
   ```

---

### 3.4 Database and Types Mapping

The `taxation_type` field must be persisted with strict type-safety boundaries between TypeScript and the SQLite database.

#### 3.4.1 Schema Modification
The `connected_accounts` table includes a nullable `taxation_type` column constrained to valid enum values:
```sql
ALTER TABLE connected_accounts ADD COLUMN taxation_type TEXT CHECK(taxation_type IN ('taxable', 'roth_ira', 'traditional_ira'));
```

#### 3.4.2 `db.ts` Mapping Logic
When retrieving and storing account configurations, `db.ts` maps the database text value to the `TaxationType` TypeScript union.
- **Reading from DB**:
  - If `taxation_type` is null or invalid, it defaults to `"taxable"`.
- **Writing to DB**:
  - The value is cast to a string and verified against the allowed set: `['taxable', 'roth_ira', 'traditional_ira']`.
```typescript
// db.ts Read Mapping
const account: ConnectedAccount = {
  id: row.id,
  userId: row.user_id,
  broker: row.broker,
  environment: row.environment,
  taxationType: (row.taxation_type as TaxationType) || "taxable"
};

// db.ts Write Mapping
const taxationTypeDbValue = account.taxationType || "taxable";
```

---

## 4. SEC 8-K RAG Ingestion & Multi-Tenant Isolation

To prevent context leakage between different users while maintaining a shared database of public filings, the vector database RAG pipeline is enhanced with strict tenant filters and rate-limiting wrappers.

### 4.1 Pinecone Filter Query Fix

To isolate user context while still allowing users to fetch standard public documents, the filter query in `retrieveContext` (`src/lib/vector-db.ts`) must support an `$or` query for the `userId` field:

```typescript
const results = await index.query({
  vector: embedding,
  topK: limit,
  filter: {
    symbol: { $eq: symbol },
    $or: [
      { userId: { $eq: userId } },
      { userId: { $eq: "local" } } // "local" acts as the public tenant id
    ]
  },
  includeMetadata: true,
});
```

---

### 4.2 Voyage API Rate Limits Batching

Voyage AI's free tier allows a maximum of 3 Requests Per Minute (RPM). The RAG pipeline processes documents in controlled batches:

- **Batch Size**: 8 documents per batch.
- **Batch Delay**: 21 seconds between requests to ensure a maximum of ~2.85 RPM.
- **Rate-Limit Retry (HTTP 429)**: The system inspects the `retry-after` header. If missing, it applies an exponential backoff sequence with randomized jitter:
  $$\text{Delay} = \text{base\_delay} \times 2^{\text{attempt}} + \text{jitter}$$

---

### 4.3 Cache Poisoning Remediations

To prevent failures from polluting the caching layer with empty structures, the following checks must be implemented:

1. **Parallel Fetch Failures**:
   In `data-providers.ts`, all Finnhub calls run in parallel via `Promise.allSettled`. If core requests are rejected, the system must throw an error, preventing the empty `{}` object from being cached under `finnhub:${symbol}`.
   ```typescript
   const allFailed = [newsRaw, quoteRaw, metricRaw].every(r => r.status === "rejected");
   if (allFailed) {
     throw new Error("Core Finnhub requests failed. Skipping cache insertion.");
   }
   ```
2. **Alpha Vantage HTTP 200 Warnings**:
   Alpha Vantage API rate limit warnings and key errors return HTTP status `200` but embed errors in the payload. The client scans the response for `"Note"`, `"Information"`, or `"Error Message"`:
   ```typescript
   if (payload && ("Note" in payload || "Error Message" in payload || "Information" in payload)) {
     throw new Error(`Alpha Vantage Warning Detected: ${JSON.stringify(payload)}`);
   }
   ```
3. **RobinhoodEnrichmentProvider Caching**:
   We wrap `RobinhoodEnrichmentProvider.enrich` with a cache lookup using the prefix `robinhood-fundamentals:${symbol}`.
   ```typescript
   const cached = cache.get(`robinhood-fundamentals:${symbol}`);
   if (cached && cached.expiresAt > Date.now()) {
     return cached.data;
   }
   ```

---

### 4.4 Multi-Tenant RAG & Rate Limit Hardening

To ensure strict tenant isolation, prevent data poisoning/spoofing, and improve the reliability of embeddings fetching, the vector database RAG pipeline must implement the following controls:

#### 4.4.1 User ID Sanitization
- During the document ingestion phase, the `userId` field must be stripped from the raw document metadata before it is sent to Pinecone.
- This prevents user-supplied metadata from spoofing or overwriting internal tenant identifiers during query routing.

#### 4.4.2 Separate Pinecone Keys Mapping
- To achieve absolute separation, the RAG engine queries public ("local" / global files) and user-specific indexes in parallel using separate API keys and namespaces if configured.
- The results are merged and ranked in-memory, ensuring that a compromise of a user index does not expose another user's private financial data.

#### 4.4.3 Linear vs. Exponential Jittered Backoff
- To handle Voyage API rate limits (such as the 3 RPM limit on free tiers), the retry mechanism should be upgraded from linear backoff to exponential backoff with randomized jitter.
- The delay calculation is formulated as:
  $$\text{Delay} = \min\left( \text{max\_delay}, \; \text{base\_delay} \times 2^{\text{attempt}} \right) + \text{random\_jitter}$$
  - `base_delay` = 1.0 second.
  - `random_jitter` = A uniform random float between $0$ and $0.5$ seconds.
  - This prevents synchronization issues (thundering herd problem) during concurrent batch ingestion.

#### 4.4.4 RAG Context Timestamps
- To prevent the LLM from making chronological or logical reasoning errors (e.g., referencing stale 8-K guidance as current), each text chunk ingested must be prepended with the publication date.
- The standard format used is:
  `[Published: YYYY-MM-DD] <chunk_text>`
- This forces the LLM's attention mechanism to recognize temporal context when analyzing financial results.

---

## 5. LLM Prompt Compaction & Multi-Tier Reasoning

To reduce context window overhead and improve the quality of AI decisions, the strategy pipeline utilizes compute-offloading and a multi-tiered reasoning loop.

### 5.1 Compute-Offloading & Compaction Model

To optimize token usage, the system offloads calculations to the backend and compresses user payloads before sending them to the LLM:

1. **Pre-Filtering**: Candidates with a composite factor score $< 40$ are excluded backend-side, focusing the LLM's attention on high-quality setups.
2. **Abbreviation Mapping**: Dictionary keys are mapped to compact representations:
   - `sym` = `symbol`
   - `px` = `price`
   - `vol` = `volume`
   - `mktCap` = `marketCap`
   - `chgPct` = `intradayChangePct`
   - `pe` = `peRatio`
   - `fcf` = `fcfYield`
   - `de` = `debtToEquity`
   - `epsGr` = `epsGrowth`
   - `shortFloat` = `shortPercentOfFloat`

---

### 5.2 Explicit LLM Parameters

To guarantee consistency and performance, LLM calls are executed with strict parameters:
- **Temperature**: `0` (ensures deterministic output and repeatable scoring).
- **Max Tokens**: `1500` (limits runaway text generation and manages API costs).
- **Cache-Control Headers**:
  Stable components (system prompts, historical reflections, and tax rules) are tagged with cache markers:
  - Anthropic: `"anthropic-beta": "prompt-caching-2024-07-31"` with `type: "ephemeral"` block markers.
  - OpenAI: Dynamic cache matching handles recurring system prompts.

---

### 5.3 Proposer-Critic Consensus Loop

The trading engine utilizes a multi-tiered consensus sequence to validate decisions:

```
               ┌───────────────────────────────┐
               │    Bull Agent (Proposer)      │
               │   Generates trade proposals   │
               └───────────────┬───────────────┘
                               │
                               ▼
               ┌───────────────────────────────┐
               │     Bear Agent (Critic)       │
               │  Identifies gaps and flaws    │
               └───────────────┬───────────────┘
                               │
                               ▼
            ┌─────────────────────────────────────┐
            │   Confidence Score >= Threshold?    │ (Threshold default: 80)
            └──────────────────┬──────────────────┘
                               │
                     ┌─────────┴─────────┐
                     │ Yes               │ No
                     ▼                   ▼
         ┌───────────────────────┐   ┌───────────────────────┐
         │ Red Team Risk Agent   │   │   Bypass Red Team     │
         │ (Devil's Advocate)    │   │   Direct to execution │
         └───────────┬───────────┘   └───────────────────────┘
                     │
            ┌────────┴────────┐
            │   Approved?     │
            └────────┬────────┘
          ┌──────────┴──────────┐
          │ Yes                 │ No
          ▼                     ▼
┌───────────────────┐  ┌───────────────────┐
│ Proceed to Order  │  │ Reject Proposal   │
│ Gating & Filters  │  │ Log in Audits     │
└───────────────────┘  └───────────────────┘
```

1. **Bull Agent (Proposer)**: Analyzes pre-filtered candidates and proposes trades with specific target entries, sizes, and thesis tags.
2. **Bear Agent (Critic)**: Critiques the proposals, evaluates risks (e.g., market regime overextension), and suggests modifications or rejections.
3. **Red Team Risk Agent (Devil's Advocate)**: Triggered only for high-conviction proposals (confidence score $\ge 80$). It critiques the thesis and attempts to find fatal flaws. If it finds a flaw, the proposal is rejected.

---

### 5.4 Exact Prompt Templates

#### 5.4.1 Bull Proposer Agent System Prompt
```markdown
You are an autonomous equity trading agent for a brokerage account.
Your task is to analyze market conditions, macroeconomic indicators, and a pre-filtered scan universe to generate trade proposals.

Execution Mode:
Current executionMode is "{{executionMode}}".
{{executionModeClarification}}

Instructions:
1. Review the macroeconomic environment and infer the current regime.
2. Cross-reference the regime with historical performance:
   - Learn from 'thesisOutcomes', 'regimeOutcomes', and 'comboOutcomes' to avoid repeating unprofitable patterns.
   - Demand higher conviction for sectors or factors with weak historical win rates.
3. Analyze the candidate list. Candidates are locally ranked to the configured scan cap, with notable below-cutoff outliers eligible for the reserve, and abbreviated:
   - 'sym': symbol, 'px': price, 'vol': volume, 'mktCap': marketCap, 'chgPct': change %, 'pe': P/E, 'pb': P/B, 'div': dividend, 'fcf': FCF Yield, 'de': D/E, 'epsGr': EPS Growth, 'shortFloat': short float %, 'secRelStr': SEC relevance, 'senateNet': Senate Net, 'newsSent': news sentiment, 'insiderSent': insider sentiment, 'posMV': position market value.
4. Construct long or short trade proposals based on clear catalysts and scoring edges.
5. Provide a confidence score (1-100) and assign one of the 10 tags from the THESIS_PLAYBOOK.

Return a strict JSON object matching the schema:
{
  "proposals": [
    {
      "symbol": "string",
      "side": "buy" | "sell" | "short" | "cover",
      "type": "market" | "limit",
      "quantity": number,
      "limitPrice": number (optional),
      "rationale": "string",
      "tradeThesisTag": "string",
      "confidenceScore": number
    }
  ]
}
```

#### 5.4.2 Red Team Risk Agent System Prompt
```markdown
You are the Red Team Risk Agent. Your job is to rigorously critique the strategy's high-conviction trade proposals.
The strategy has proposed to {{side}} {{symbol}} with a confidence score of {{confidenceScore}}/100.
Proposer Rationale: {{rationale}}

Your objective is to play the Devil's Advocate. You must actively search for reasons why this trade will FAIL.
- If the proposal is a BUY or COVER, you are the BEAR. Look for poor fundamentals, weak margins, high leverage, or overbought technical indicators.
- If the proposal is a SELL or SHORT, you are the BULL. Look for hidden assets, insider buying, strong cash flow, or oversold technical indicators.

Analyze the provided 'retrievedFinancialContext' (RAG context snippets) and check for warning signs like regulatory issues, supply chain disruptions, or management changes.

If you find a critical flaw that invalidates the proposer's rationale, you must REJECT the proposal.
If the rationale is sound and you cannot find a critical flaw, you must APPROVE the proposal.

Respond with a JSON object containing:
- "rejected": boolean (true if you reject the proposal, false if you approve)
- "reason": "string" (detailed counter-argument or approval explanation)
```

---

### 5.5 Prompt Caching Surcharge & Eviction

Anthropic's prompt caching feature (using the `ephemeral` cache control marker) has a Time-To-Live (TTL) of 5 minutes. If requests are sent less frequently than every 5 minutes, cache misses occur, resulting in a surcharge (higher pricing for cache-write/cache-miss processing).

#### 5.5.1 Cadence-Aware Caching
- **Dynamic Caching Toggle**: The execution engine should track the scan frequency. If the scan interval (cadence) is configured to be greater than 5 minutes (300 seconds), the system should automatically deactivate cache-control flags/headers to avoid incurring the prompt caching surcharge on cache misses.
- **Static vs. Dynamic Prompts Splitting**: System prompts, macro regimes, and tax rules are separated from volatile candidate lists. Static components are structured in a single leading block to ensure they remain eligible for caching, while dynamic candidates are placed at the end of the payload.

---

### 5.6 Prompt Abbreviations Glossary

To ensure prompt compaction does not introduce semantic ambiguity, the system enforces a strict mapping glossary. The following abbreviated keys are used when structuring payloads sent to the LLM:

| Abbreviation | Expanded Metric | Definition & Unit |
| :--- | :--- | :--- |
| `sym` | Symbol | Ticker symbol of the stock |
| `px` | Price | Current market price |
| `vol` | Volume | 24-hour trading volume (number of shares) |
| `mktCap` | Market Capitalization | Total dollar value of outstanding shares |
| `chgPct` | Change Percentage | Intraday price change (%) |
| `pe` | P/E Ratio | Price-to-Earnings ratio |
| `pb` | P/B Ratio | Price-to-Book ratio |
| `div` | Dividend Yield | Annual dividend payout per share (%) |
| `fcf` | FCF Yield | Free Cash Flow yield (%) |
| `de` | Debt-to-Equity | Debt-to-Equity ratio |
| `epsGr` | EPS Growth | Earnings Per Share growth rate (%) |
| `shortFloat` | Short float % | Percentage of float shares shorted (%) |
| `secRelStr` | SEC Relevance Strength | Score matching SEC 8-K RAG context relevance (0-100) |
| `senateNet` | Senate Net Buying | Net dollar value of trades executed by US Senators ($) |
| `newsSent` | News Sentiment | Composite sentiment score from news articles (-1.0 to 1.0) |
| `insiderSent` | Insider Sentiment | Composite sentiment score from corporate insider trades (-1.0 to 1.0) |
| `posMV` | Position Market Value | Total current market value of the position ($) |
