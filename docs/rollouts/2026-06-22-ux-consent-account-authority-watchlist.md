# 2026-06-22 - UX fixes: consent copy, account label, authority labels, watchlist self-heal

## Summary

A batch of dashboard UX fixes plus a real bug where a legacy unsupported
watchlist symbol (e.g. `BTC`) could brick *all* policy updates.

1. **Consent dialog copy** — "One-time choice — can be changed later in Settings"
   → "Can be changed later in Settings" (the two clauses contradicted each other).
2. **Account dropdown label** — no longer renders the environment twice. An account
   named "Alpaca (Paper)" showed as "Alpaca (Paper) (paper)"; the `(environment)`
   suffix is now omitted when the label already contains it → "Alpaca (Paper)".
3. **Strategy-authority labels** — renamed user-facing "Decide" → "Autonomous"
   and simplified "Propose"; the stored values (`propose`/`decide`) are unchanged.
   Updated the top-bar dropdown, Settings dropdown, the start/enable confirm
   dialogs, the active-strategy subtitle, the authority-mode help text, and the
   mode tooltip.
4. **Unsupported-symbol bug (root cause + hardening):**
   - The PUT `/api/policy` handler validated the *entire* policy and returned 400
     if any persisted symbol was unsupported. Because the client always re-sends
     the full policy on every change, a single stale `BTC` in `additionalSymbols`
     made **every** subsequent policy update fail (this is why toggling to
     Autonomous failed and stayed on Propose). Now the handler **sanitizes**
     `additionalSymbols`/`blocklist` — normalizes and drops unsupported symbols
     (equity-only: S&P 500 / Nasdaq 100 / Dow 30) — instead of 400-ing, so a
     legacy bad symbol self-heals on the next save and can never brick updates.
   - The Settings "Additional Watchlist" / "Ignore List" / allowlist inputs
     already reject unsupported symbols at add time with a clear toast; that's
     kept (this is the "don't let me add it in the first place" behavior).
   - **No silent loss:** `updatePolicy` now diffs the sent policy against the
     saved one and, if the server dropped any watchlist/ignore symbols as
     unsupported, shows a `warning` toast naming them ("Removed unsupported
     symbol(s): …") instead of a plain success. This guarantees a user is never
     left thinking a symbol is being watched when it isn't — covering legacy
     stuck entries and any future non-validating add path, on top of the
     add-time rejection. Helper: `droppedUnsupportedSymbols(sent, saved)`.
   - The active-account check wrapped the broker `getAccounts()` call in
     try/catch so a transient broker/network failure returns a clean message
     instead of an unhandled 500 (the likely cause of the earlier full-height
     "big HTML error" — a raw error page dumped into the toast).
   - `updatePolicy` in the client no longer renders a raw/HTML error body in the
     toast: non-OK responses show a concise message (or `Policy update failed
     (<status>)` when the body is HTML or oversized).

## Files

- `app/api/policy/route.ts` — `sanitizeSymbolList()` helper; sanitize
  additionalSymbols/blocklist; removed the symbol 400s; try/catch broker check.
- `app/dashboard-client.tsx` — consent copy; account-label dedup; authority
  labels/copy (dropdowns, confirm dialogs, subtitle, help, tooltip); robust
  `updatePolicy` error handling.
- `STATUS.md`, this rollout note.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run test/policy.test.ts test/policy-default-universe.test.ts` — 42/42.
- `npm test` — 855 pass; 1 fail = pre-existing date-sensitive `cache-provenance.test.ts` (green in CI).
- `npm run build` — succeeds.

## Owner action (data, not code)

- **Delete the duplicate/faulty Alpaca paper account**: Accounts → find the stale
  "Alpaca Paper" row → **Remove** (DELETE `/api/connected-accounts/{id}`). The
  label fix only stops the doubled "(paper)"; removing the extra account is a
  data action only you can take on your data.
- If `BTC` (or any unsupported symbol) is still shown in your watchlist after
  deploy, it will be dropped automatically on the next settings save; you can
  also click its × chip to remove it immediately.

## Follow-ups

- Could not reproduce the exact first-attempt "big HTML error" overlay, but both
  plausible sources are now hardened (broker 500 → clean 400 message; client
  toast no longer renders HTML bodies).
