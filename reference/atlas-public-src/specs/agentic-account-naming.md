# Account naming & display standard (for the `agentic-trading` app)

**Status:** spec / implementation brief. Written in the `public` repo because that's the only repo
the authoring session could reach; **implement in `jaywedgeworth22/agentic-trading`.**

## Goal

Consistent, broker-aware account labels across **(1) the top account selector**, **(2) the
Portfolio panel header**, and **(3) Account settings**. Use each broker's *own* account-type noun
(Robinhood calls them "Agentic", Alpaca calls them "Brokerage") but format them to a shared pattern
so the three surfaces match and the brokers don't look wildly different from each other.

## The problem today

- The **top dropdown** currently shows **"Agentic"** — it should show the **brand: "Robinhood"**.
- The **Portfolio** header shows **"Brokerage Account"** for the Robinhood account — that
  "Brokerage Account" wording should be **reserved for Alpaca live**, not Robinhood.
- The **Test** account shows generic wording — it should read **"Local Test Account"**.
- The selector, Portfolio header, and settings don't use the same source, so they drift.

## Display-name standard

Pattern: **`<Brand> <ProviderAccountType> (<acct#>)`**

| Account | Top selector (short) | Portfolio header + Account settings (full) |
|---|---|---|
| **Robinhood** | `Robinhood` | `Robinhood Agentic (••••1234)` |
| **Alpaca Live** | `Alpaca` | `Alpaca Brokerage Account (••••5678)` |
| **Test / local** | `Local Test` | `Local Test Account` *(no acct #)* |

Rules:
- **Brand prefix** unifies the format; **provider's native account-type noun is preserved**
  (Robinhood → "Agentic"; Alpaca → "Brokerage"/"Brokerage Account").
- **Account number** appended in parentheses; omit the parenthetical when there is no real number
  (Test/local).
- The **top selector** leads with the brand (short); the **Portfolio header and settings** use the
  full formatted name. Same words across header and settings.

## Standardize so it stays consistent

Single source of truth — one formatter/config, e.g. `lib/accountDisplay.ts`:

```
formatAccount({ provider, accountType, accountNumber, isReal })
  -> { shortLabel, fullLabel, badge }
```

- `provider` → brand string ("Robinhood", "Alpaca", "Local Test").
- `accountType` → provider-native noun ("Agentic", "Brokerage Account").
- `accountNumber` → masked (see below); drives the `(…)` suffix.
- **All three surfaces consume this formatter** — selector uses `shortLabel`, Portfolio header +
  settings use `fullLabel` — so they can never drift. New brokers added later just register a
  brand + native noun and inherit the format automatically.

## Account-number masking (one decision needed)

Recommended default: **mask to last 4** (`••••1234`) so screenshots / shoulder-surfing don't leak
the full number, with an optional **reveal toggle** for the full value. (You wrote `(#####)`; confirm
whether you want the **full** number shown or **masked last-4** as the default.)

## Edge cases

- **Two accounts at the same broker** → disambiguate by the acct# suffix (and/or a nickname field).
- **Test/local** → never shows a number or brokerage wording; always exactly `Local Test Account`.
- Keep the badge/color cues already in use (e.g., TEST vs LIVE) aligned with these labels.

## Relationship to other work

This continues the earlier "Portfolio rename + show account number under Portfolio (instead of
'Test Account')" change, and should land alongside the unified notifications + event-based alerts
work tracked in `docs/specs/atlas-to-agentic-merge-checklist.md`.
