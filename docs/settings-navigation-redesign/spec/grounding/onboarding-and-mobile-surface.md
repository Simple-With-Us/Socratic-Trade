## Onboarding & Auth Flow

### Welcome Page
**File:** `app/welcome/page.tsx`

- **Public landing page** shown when `LANDING_PAGE_ENABLED=true`
- Features marketing for the platform:
  - Market scanning & enrichment (line 34-35)
  - Multi-lens evaluation (line 38-40)
  - Paper trading via connected broker (line 42-43)
  - Transparent strategy & learning (line 46-47)
  - Risk controls & approval gates (line 50-51)
  - User stays in control (line 54-55)
- Three-step workflow displayed (lines 59-78): scan → evaluate → test/decide
- Call-to-action: "Request access" (email to mail@jays.services)

### Login/Sign-In Page
**File:** `app/login/page.tsx`

- **Minimal OAuth sign-in page** shown when `authConfigured=true` (line 12, force-dynamic)
- Supports multiple providers (read from `process.env` at request time):
  - **Google** (lines 15, 33-47): `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`
  - **GitHub** (lines 16, 49-64): `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`
  - **Apple** (lines 17, 65-89): `AUTH_APPLE_ID` / `AUTH_APPLE_SECRET`
- Warning for Apple-only setups (lines 81-89): Apple only sends email on first auth; if session expires, re-auth fails without email
- Fallback when no provider configured: error message with env var setup instructions (lines 91-103)

**Auth Module:** `src/lib/auth/auth.ts`

- Auth.js v5 with JWT sessions (stateless, no DB adapter)
- Email embedded in JWT token; exposed via `auth()` in route handlers
- Optional Cloudflare Access or server-session fallback if OAuth not configured

---

## Connected Accounts & Strategy Profiles

### Creating/Listing Connected Accounts
**API:** `app/api/connected-accounts/route.ts`

**GET** (line 17): List user's connected accounts (no secrets exposed)
- Returns: `id`, `broker`, `environment`, `accountNumber`, `label`, `taxationType`, `isActive` (line 19-28)

**POST** (line 31): Create or update a connected account
- Supports brokers: `alpaca`, `alpaca-mcp`, `robinhood`, `test` (line 35-39)
- **Robinhood flow** (lines 48-83):
  - Syncs live agentic account from Robinhood MCP (no hand-typed numbers)
  - Prefers account labeled "Agentic"; fails closed if multiple eligible accounts (lines 54-63)
  - Idempotent: reuses existing row if already synced (line 66-68)
  - Auto-activates on first connect when no other account active (line 80)
- **Alpaca flow** (lines 87-126):
  - Paper vs live inferred from account number prefix (`PA*` / `PK*`) or env (lines 92-99)
  - Requires manual `accountNumber` entry (lines 87-89)
  - API key/secret encrypted and stored (line 115-116)
- **Test broker** (lines 95-96): always "paper" environment

### Activating a Connected Account
**API:** `app/api/connected-accounts/[id]/activate/route.ts`

**POST** (line 7): Set an account as active
- **Function:** `setActiveConnectedAccount(id, userId)` (line 10, from `db-api-keys.ts:681`)
- Atomically deactivates all other accounts for the user and marks this one active (lines 686-687)

---

## Strategy Profiles & Policy Management

### Creating & Managing Profiles
**API:** `app/api/profiles/route.ts`

**GET** (line 7): List all strategy profiles for user
- **Function:** `listStrategyProfiles(userId)` → ordered by active DESC, name ASC

**POST** (line 11): Create a new strategy profile
- Fields: `name`, `policy` (Partial<TradingPolicy>), `prompt`, `active` (boolean) (lines 14-22)
- **Function:** `createStrategyProfile()` (from `db-profiles.ts:467`)

### Activating a Profile
**API:** `app/api/profiles/[id]/activate/route.ts`

**POST** (line 7): Activate a strategy profile
- **Function:** `activateStrategyProfile(id, userId)` (line 10, from `db-profiles.ts:518`)
- Deactivates all other profiles atomically
- Mirrors policy/prompt to active account's live state via `mirrorPolicyToActiveAccount()` (line 531)

---

## Per-Account Live Strategy State

**File:** `src/lib/db-profiles.ts` (the core isolation module)

### Policy Tiering
**User-level fields** (stored in `user_settings.policy`):
- `notificationSettings`, `marketScanCandidateLimit`, `marketScanOutlierReserve` (lines 20-24)
- Applied to ALL accounts; cross-account configuration

**Account-level fields** (stored in `account_strategy_state`):
- Everything else (prompt, models, weights, risk rules, limits)
- Per-account isolated: different accounts can have different settings

### Reading Policy
**Function:** `getPolicy(userId, connectedAccountId?)` (line 330)

1. Resolves the active account if no `connectedAccountId` specified (line 331)
2. Reads `account_strategy_state` row if exists (lines 335-344)
3. **Halted coercion site #1** (lines 348-350):
   ```typescript
   if (account.id !== activeId && policy.systemState === "active") {
     policy = { ...policy, systemState: "halted" };
   }
   ```
   Non-active accounts can NEVER run autonomously, even if their profile says "active"

4. Overlays user-level fields from `user_settings.policy` on top (line 359-363)
5. Returns merged policy with `connectedAccountId`, `activeBroker`, `accountNumber`, `paperMode` set

### Writing Policy
**Function:** `setPolicy(policy, userId, connectedAccountId?)` (line 412)

- Splits policy into user-level and account-level fields
- Writes user fields to `user_settings.policy`
- Writes account fields to `account_strategy_state`
- Calls `mirrorPolicyToActiveAccount()` to sync active account state (line 419-420)

### Mirroring Policy to Active Account
**Function:** `mirrorPolicyToActiveAccount(userId, policy, prompt, scoringWeights, derivedFromProfileId)` (line 249)

- Called by every effective-policy writer
- Writes to the ACTIVE account's `account_strategy_state` so live state never goes stale
- No-op when there is no active connected account

### Migration: Legacy Strategy Model Fields → Accounts
**Function:** `migrateLegacyStrategyModelFieldsToAccounts(userId)` (line 261)

- Back-compat: moves legacy `llmModel`, `redTeamLlmModel`, `llmReasoningEffort` from user-settings into account-scoped rows
- Called on first policy read/write to lazily migrate old single-account users
- **Halted coercion site #2** (lines 283-284):
   ```typescript
   if (account.id !== activeId && policy.systemState === "active") {
     policy = { ...policy, systemState: "halted" };
   }
   ```
   When seeding account_strategy_state for non-active accounts, force `systemState: "halted"`

### Copying a Profile to a Specific Account (PR 2)
**Function:** `applyProfileToAccount(profileId, connectedAccountId, userId)` (line 547)

- Copies a library strategy profile into a CHOSEN account's live state (NOT just active account)
- Does NOT change which account is active or the library profile itself
- Only writes the target account's `account_strategy_state` row with `derived_from_profile_id` provenance
- **Safety:** preserves target account's current `systemState` (line 557)
  - Applying a strategy is config-only; never arms autonomy on a halted account (lines 557-562)
  - Mirrors the per-account autonomy opt-in guard

---

## Execution Modes (Test/Paper/Live)

**File:** `src/lib/execution-mode.ts`

### Mode Determination
**Function:** `deriveExecutionState(policy, activeAccount?)` (line 23)

Modes derived from **two signals**:
1. **`policy.paperMode`** — legacy boolean (line 41)
2. **`activeAccount`** — which connected account is selected (line 41)

**Decision tree:**
- `paperMode=true` OR no active account → **Test (local simulation)** (lines 42-54)
  - Uses app's local simulator, NOT Alpaca Paper
  - `submitsBrokerOrders: false`

- Active account is paper environment → **Broker Paper** (lines 57-70)
  - `environment === "paper"` (line 57)
  - Submits real orders to broker paper endpoint
  - `submitsBrokerOrders: true`

- Active account is live environment → **Broker Live** (lines 73-85)
  - `environment === "live"`
  - Submits real orders to broker production endpoint
  - `submitsBrokerOrders: true`

### Active Account Selection
**Singleton:** `getActiveConnectedAccount(userId)` (from `db-api-keys.ts:580`)

- Query: `SELECT * FROM connected_accounts WHERE user_id = ? AND is_active = 1 LIMIT 1`
- Returns the ONE account marked `is_active=1` per user
- Never null at runtime because a "Test" account is auto-created/ensured (lines 566-578)

**Setter:** `setActiveConnectedAccount(id, userId)` (from `db-api-keys.ts:681`)

- Atomic transaction: deactivates ALL other accounts, activates this one
- Validates account exists and belongs to the user (lines 684-687)
- Called by mobile command `account.activate` and UI account picker

---

## Mobile Surface & Command API

**File:** `src/lib/mobile-api.ts` (core business logic)
**Route:** `app/api/mobile/commands/route.ts` (HTTP endpoint)
**Page:** `app/mobile/page.tsx` (PWA client)

### Supported Commands
**List:** `MOBILE_COMMAND_TYPES` (lines 38-54)

```
strategy.run_once       — Manual strategy run
strategy.start          — Set systemState to "active"
strategy.stop           — Set systemState to "halted"
strategy.close_only     — Set systemState to "close_only"
strategy.liquidating    — Set systemState to "liquidating"
proposal.approve        — Execute a pending proposal
proposal.reject         — Reject a proposal
account.activate        — Set active connected account (writes singleton)
watchlist.add           — Add symbol to watchlist
watchlist.remove        — Remove symbol from watchlist
alert.create            — Create price alert
alert.delete            — Delete price alert
policy.patch            — Update policy fields (see normalizePolicyPatch)
consent.set             — Set data pool consent flag
notification.test       — Test notification delivery
```

### Command Queueing & Execution
**Function:** `queueMobileCommand(input)` (line 430)

- Validates & normalizes payload per command type (lines 388-428)
- Handles idempotency keys (line 439)
- Inserts into `mobile_commands` table with status="queued" (lines 443-472)
- Emit event to listeners (line 487)

**Function:** `processPendingMobileCommands(options)` (line 711)

- Worker that claims next queued command and executes it (line 721)
- Runs 1–10 commands per call (configurable `limit` parameter)
- Sets status to "running" → "succeeded"/"failed" (lines 522-538)

**Function:** `executeMobileCommand(command)` (line 701)

- Routes to `runCommand(command)` which dispatches per command type (line 621)

### Critical Commands: Active-Account Writes

**`account.activate`** (lines 647-651):
```typescript
case "account.activate": {
  const accountId = String(payload.accountId);
  setActiveConnectedAccount(accountId, command.userId);
  // Writes the active-account singleton
  return { ok: true, activeAccount: ... };
}
```
- **P2 Hazard:** writes the active-account singleton (as warned in task brief)
- Changes execution mode for ALL subsequent operations

**`policy.patch`** (lines 675-676):
```typescript
case "policy.patch":
  return applyPolicyPatch(command.userId, payload.patch as Partial<TradingPolicy>);
```
- Calls `applyPolicyPatch(userId, patch)` (lines 596-619)
- Merges patch into current policy, validates constraints, calls `setPolicy()`
- **Does NOT set active account** but may affect mode (if changing indices/symbols)
- Forbidden fields (lines 264-268):
  - `userId`, `accountNumber`, `connectedAccountId`, `activeBroker`, `paperMode`
  - `apiKey`, `apiSecret`, `providerSecret` — cannot be modified via mobile

**`strategy.start/stop/close_only/liquidating`** (lines 629-636):
```typescript
case "strategy.start":
  return setStrategyState(command.userId, "active");
```
- Calls `setStrategyState(userId, state)` (lines 576-594)
- Validates account exists and is agentic_allowed (lines 579-588)
- Calls `setPolicy(next, userId)` (line 591) — writes to user-level policy
- Does NOT change active account; assumes it's already set

### Mobile HTTP API
**Route:** `POST /api/mobile/commands` (lines 27-57)

- Rate-limited: 60 commands per minute per user (line 35)
- Accepts JSON: `{ commandType, payload?, idempotencyKey?, client? }`
- Returns: `{ command, deduped }` or error
- Status 202 (Accepted) if new command queued, 200 if deduplicated (line 52)

**Route:** `GET /api/mobile/commands` (lines 15-25)

- Query params: `?status=queued|running|succeeded|failed|cancelled&limit=50` (default 50, max 200)
- Returns: `{ commands: [PublicMobileCommand[]] }` (redacted payloads)

### Mobile Readiness & Control Catalog
**Function:** `mobileReadiness(userId)` (line 762)

Returns readiness state:
- `hasAccount` — is `policy.accountNumber` set
- `hasUniverse` — indices or additional symbols configured
- `systemState` — current autonomy state
- `strategyAuthority` — propose vs decide
- `selectedAccountNumber` — active account's number
- `activeConnectedAccount` — full active account object
- `dataPoolConsent` — consent flag
- `commandBacklog` — queued/running counts

**Function:** `mobileControlCatalog()` (line 740)

Returns platform metadata:
- Auth mode: "server-session" (no mobile secrets stored client-side)
- Real-time SSE: `/api/mobile/events` (lines 750)
- Account deletion: `/api/mobile/account-deletion/{request,confirm}` (lines 752-756)
- All command types with `{ type }` metadata (line 758)

---

## Summary Table: Data Flow & Consistency

| Artifact | Owner | Scope | Writer(s) | Reader(s) | Isolation |
|----------|-------|-------|-----------|-----------|-----------|
| `user_settings.policy` | User | Cross-account | `setPolicy()`, profile activate | `getPolicy()`, `peekPolicy()` | User-level fields only |
| `account_strategy_state` | Account | Per-account | `writeAccountStrategyState()`, `mirrorPolicyToActiveAccount()` | `getPolicy()`, `peekPolicy()` | Keyed by (user_id, connected_account_id) |
| `connected_accounts.is_active` | User | Singleton | `setActiveConnectedAccount()`, `upsertConnectedAccount()` | `getActiveConnectedAccount()`, `getPolicy()` | One TRUE per user |
| `strategy_profiles.*` | User | Library | `createStrategyProfile()`, `updateStrategyProfile()`, `activateStrategyProfile()`, `applyProfileToAccount()` | `listStrategyProfiles()`, `getActiveStrategyProfile()` | User-scoped copyable library |
| `mobile_commands.*` | User | Queue | `queueMobileCommand()`, `processPendingMobileCommands()` | `listMobileCommands()`, `getMobileCommand()` | Audit trail for mobile ops |

---

## Key Architecture Decisions

1. **Active account is a persistent singleton** (`is_active=1` in `connected_accounts`) that determines execution mode and acts as the default context for all policy reads

2. **Per-account state isolation** via `account_strategy_state` ensures non-active accounts cannot autonomously trade even if their profile says "active" (halted coercion sites in `getPolicy()` lines 348-350, 396-397)

3. **Policy tiering** separates user-wide config (notifications, market-scan breadth) from account-specific strategy (prompt, models, limits) so users can reuse settings across accounts

4. **Mobile commands queue** with idempotency, rate-limiting, and audit trails; critically, `account.activate` writes the active-account singleton, making it the command that most broadly affects system behavior

5. **Strategy profiles as copyable library** allows users to clone a configuration to a non-active account (PR 2: `applyProfileToAccount()`) without changing which account is active, preserving autonomy guardrails
