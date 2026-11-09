# 2026-06-25 — Robinhood agenticAllowed default fix

## Summary

Fixed a bug where all Robinhood brokerage accounts showed the warning
"Selected broker account is not currently available for agentic execution."

## Why

The Robinhood MCP `get_accounts` response does not include an `agentic_allowed`
or `agenticAllowed` field. The existing code was:

```ts
agenticAllowed: Boolean(item.agentic_allowed ?? item.agenticAllowed),
```

`Boolean(undefined ?? undefined)` evaluates to `false`, so every account was
flagged as ineligible for agentic execution regardless of account type.

An initial fix defaulted to `true` unconditionally, but Codex review (PR #151)
correctly flagged that this would also mark IRA/Roth accounts as agentic, and
that `accounts.find((a) => a.agenticAllowed)` would then select the first account
returned (possibly a read-only IRA) instead of the actual trading account.

## Fix

Default to `accountType === "brokerage"` instead of `true`:

```ts
agenticAllowed: Boolean(item.agentic_allowed ?? item.agenticAllowed ?? (accountType === "brokerage")),
```

The `accountType` derivation already correctly classifies:
- `roth_ira` — brokerage_account_type contains "roth"
- `traditional_ira` — brokerage_account_type contains "ira" or "traditional"
- `brokerage` — everything else (standard trading account)

This means:
- Standard brokerage accounts with no explicit field → `true` (agentic allowed)
- IRA/Roth accounts with no explicit field → `false` (correctly excluded)
- Any account with an explicit `agentic_allowed: false` → still `false` (override respected)


## Account selection improvement

`app/api/connected-accounts/route.ts` was also updated: when multiple eligible
accounts exist, prefer the one with "agentic" in its label (e.g. `nickname: "Agentic"`)
before falling back to the first agenticAllowed account. This prevents a read-only
Investing account from being selected over a labelled Agentic account in edge cases
where a user has multiple non-IRA brokerage accounts.

## Files

- `src/lib/robinhood.ts` — `agenticAllowed` computation
- `app/api/connected-accounts/route.ts` — prefer "agentic"-labelled account in selection
- `STATUS.md` — added entry
- `docs/rollouts/2026-06-25-robinhood-agentic-default.md` — this file

## Verification

```bash
npx tsc --noEmit   # clean
npm test           # 1150/1151 (cache-provenance date flake is pre-existing, unrelated)
npm run build      # clean — all routes compile and bundle successfully
```

## Follow-ups

- If Robinhood ever adds `agentic_allowed` to the `get_accounts` response, the
  explicit field will correctly override the default via `??`.
- No migration needed — this is a runtime derivation, not persisted state.

---

## 2026-06-25 addendum — Assistant ignores lowercase ticker queries

### Summary

The Assistant tab returned its canned intro message for every query (e.g. "how much is aapl").

### Root cause

`classifyIntent` in `src/lib/chat/llm.ts` extracted ticker symbols with `/\b([A-Z]{2,5})\b/` —
uppercase only. All-lowercase input like "how much is aapl" found no symbol, so
`sym` was `undefined`, the quote-intent branch was skipped, and `groundedChat()`
returned the fallback message.

### Fix

Two-pass extraction. First pass: uppercase-only (existing behavior, no change for normal input).
Second pass: phrase-pattern fallback using structured quote phrases like
`"how much is X"`, `"price of X"`, `"X price"`, `"quote for X"` — avoids false
matches on ordinary English words.

Verified:
- "how much is aapl" → `{ intent: "quote", symbol: "AAPL" }` ✓
- "aapl price" → `{ intent: "quote", symbol: "AAPL" }` ✓
- "AAPL price" → `{ intent: "quote", symbol: "AAPL" }` ✓ (unchanged)
- "what is the weather" → `{ intent: "chat" }` ✓ (no false positive)

### Files

- `src/lib/chat/llm.ts` — `classifyIntent`, symbol extraction block

---

## 2026-06-25 addendum — cache-provenance.test.ts CI flake fixed

### Summary

Fixed the pre-existing CI failure in `test/cache-provenance.test.ts:112` that was blocking this PR from merging.

### Root cause

The test "user-keyed result is NOT returned for a different userId (no cross-user leak)" called `vi.unstubAllGlobals()` before userB's `fetchMacroData()` call, relying on all network calls failing with the real `fetch`. A Yahoo VIX fallback path was added to `fetchMacroData` (to provide a partial regime signal without FRED) after the test was written. In CI where outbound network is allowed, `fetchVixFromYahoo()` can reach Yahoo Finance and succeed, causing `asOf` to be set to today's date rather than `"unavailable"`, breaking the assertion.

### Fix

Replaced `vi.unstubAllGlobals()` with `vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in test")))` so the Yahoo VIX fetch also fails deterministically. No production code changed.

### Files

- `test/cache-provenance.test.ts` — line 107, replaced `vi.unstubAllGlobals()` with a rejecting fetch stub

### Verification

```bash
npx vitest run test/cache-provenance.test.ts   # 8/8 passed
npm test                                        # 1151/1151 passed
```
