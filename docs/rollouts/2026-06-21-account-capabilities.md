# 2026-06-21 — AccountCapabilities classifier

## Summary

Added `AccountCapabilities` as a first-class type that captures what a brokerage
account can actually do. Every connected account now carries a capabilities blob
(stored as JSON in the DB), and the policy engine enforces capabilities alongside
the existing policy flags.

### What was added

- **`AccountCapabilities` interface** (`src/lib/types.ts`): fields covering
  `equityTrading`, `shortSelling`, `optionsTrading` + `optionsLevel` (0–4 CBOE tier),
  `futuresTrading`, `cryptoTrading`, `marginEnabled` + `marginRequirementPct`, and
  `accountType` (`"brokerage" | "traditional_ira" | "roth_ira" | "crypto_exchange"`).
  All booleans default to false on absent/legacy rows — safe by default.

- **`BrokerageAccount.capabilities`**: live capabilities returned from the broker
  on each `getAccounts()` call.

- **`ConnectedAccount.capabilities`**: persisted snapshot stored alongside the
  account row. Populated on Robinhood connect/re-sync; Alpaca: parsed on the fly.

- **Robinhood gateway** (`src/lib/robinhood.ts`): parses `option_level` (→ 0–4),
  `account_type` (cash/margin → `marginEnabled`), and `brokerage_account_type`
  (→ `accountType` IRA detection). `shortSelling` is hardcoded false — the
  Robinhood MCP `review_equity_order` docs explicitly state "no short sells".

- **Alpaca gateway** (`src/lib/alpaca.ts`): reads `account.shorting_enabled`
  (→ `shortSelling`) and `account.account_type` (→ `marginEnabled`). Alpaca
  REST v2 does not include options or crypto, so those remain false.

- **Test broker** (`src/lib/robinhood.ts` TestBrokerGateway): hardcoded safe
  defaults (equity only, no shorts, no margin).

- **DB migration** (`src/lib/db.ts`): `ALTER TABLE connected_accounts ADD COLUMN
  capabilities TEXT` on first boot; `COALESCE` on upsert so re-syncs don't
  overwrite a previously-stored value with null.

- **Policy engine** (`src/lib/policy.ts`): two-layer short-selling gate — now
  requires BOTH `policy.shortSellingEnabled = true` AND
  `accountCapabilities.shortSelling = true`. If the broker doesn't support it,
  proposals are rejected even if the policy flag is on.
  `PolicyContext` gains an optional `accountCapabilities` field.

- **Strategy** (`src/lib/strategy.ts`): threads `selected?.capabilities` (from
  `getAccounts()`) into `evaluateTradeProposal` at both the strategy-run and
  proposal-approval sites.

- **Connected-accounts route** (`app/api/connected-accounts/route.ts`): persists
  `agentic.capabilities` on Robinhood connect/re-sync.

- **Dashboard UI** (`app/dashboard-client.tsx`): account cards in the Integrations
  section now show coloured capability badges:
  - Blue  → Roth IRA / Trad IRA
  - Yellow → Margin
  - Orange → Short
  - Purple → Options L1–L4
  - Cyan   → Crypto
  - Pink   → Futures

### Verification of Robinhood short selling

Confirmed NOT supported, via two independent code comments:
1. `src/lib/types.ts` (pre-existing): "Robinhood does not currently support equity
   shorting via MCP"
2. `src/lib/robinhood.ts` (pre-existing): MCP `review_equity_order` docs explicitly
   state "no short sells"

The Robinhood gateway now hardcodes `shortSelling: false` in `AccountCapabilities`
regardless of account type.

## Why

User request: classify what each account can actually do (short, options level,
margin, account type / tax regime) so policy can enforce capabilities rather than
relying solely on a global policy flag that is broker-agnostic. Future crypto
exchange connections should be addable without a schema change.

## Files touched

- `src/lib/types.ts` — `AccountCapabilities` interface; updated `BrokerageAccount`,
  `ConnectedAccount`; deprecated note on `taxationType`
- `src/lib/policy.ts` — `AccountCapabilities` import; `accountCapabilities` on
  `PolicyContext`; two-layer short gate
- `src/lib/robinhood.ts` — `AccountCapabilities` import; Robinhood + Test gateway
  `getAccounts()` now return capabilities
- `src/lib/alpaca.ts` — `AccountCapabilities` import; Alpaca `getAccounts()` now
  returns capabilities
- `src/lib/db.ts` — `AccountCapabilities` import; `parseCapabilities()` helper;
  migration; `listConnectedAccounts` + `getActiveConnectedAccount` + `upsertConnectedAccount`
  all updated
- `app/api/connected-accounts/route.ts` — persist Robinhood capabilities on connect
- `app/dashboard-client.tsx` — capability badges on account cards
- `test/policy.test.ts` — added `shortCapableAccount` fixture; updated
  disabled-path message assertions; added `accountCapabilities` to enabled-path tests
- `docs/rollouts/2026-06-21-account-capabilities.md` (this note)

## Verification

```
npx tsc --noEmit   # exit 0 (clean)
npm test           # 390/390 passing (49 files)
npm run build      # green
```

## Follow-ups

- **Re-sync on connect**: Robinhood capabilities are only parsed on connect or
  manual re-sync — they are not re-fetched on every strategy run (intentional;
  capabilities rarely change and we don't want the overhead). A "Re-sync account"
  button could be added to the Edit dialog later.
- **Alpaca options**: Alpaca REST v2 standard doesn't expose options. If using
  Alpaca Options API (separate product), set `optionsTrading` / `optionsLevel`
  manually or add a settings field in the Edit dialog.
- **Manual capability override in UI**: the Edit dialog currently does not expose
  individual capability checkboxes — they are broker-read-only. A future PR could
  let power users override (e.g. manually confirm their Alpaca options approval).
- **`taxationType` deprecation**: existing rows that set `taxationType` still work
  (the field is read by `src/lib/tax.ts`). For new accounts, `capabilities.accountType`
  is the canonical source. A migration could back-fill `capabilities` from
  `taxationType` for legacy rows.
- **CI workflows**: the three `ci-pending/` workflow files were staged for move to
  `.github/workflows/` in this same commit. Token re-scope (`gh auth refresh -h
  github.com -s workflow`) is required before pushing them to GitHub.
