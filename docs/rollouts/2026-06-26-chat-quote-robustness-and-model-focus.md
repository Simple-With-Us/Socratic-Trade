# 2026-06-26 — Chat quote robustness (gateway-agnostic fallback) + focus prompt after model pick

Branch `fix/chat-quote-fallback-and-focus` (throwaway worktree `~/apps/trading-ag13`, off `origin/main`
which already has #174). Follow-up to #174 after the operator still saw `NO_QUOTE` for VZ.

## Changes
1. **Chat quote is now gateway-agnostic + can't be aborted by a broker failure** (`src/lib/chat/
   orchestrator.ts` `getQuote`). #174 added the keyless daily-close fallback inside the *Alpaca
   gateway*; this adds the same fallback at the *chat layer* and fixes two robustness gaps:
   - The broker quote call now has its OWN try/catch, so a broker throw (auth/data-plan/network)
     **falls through** to the market-data fallback instead of returning `QUOTE_FAILED`.
   - Dropped the `NO_ACCOUNT` hard-fail — "what's X at?" now answers from market data even with no
     account selected.
   - Order: broker quote (if account + price > 0) → keyless `fetchDailyOHLC` last close
     (`yahoo-finance-delayed`) → `NO_QUOTE` only if both miss.
2. **Focus the prompt box after picking a model** (`app/ui/assistant-console.tsx`). The chat `<textarea>`
   got a ref; the model `<select>`'s `onChange` now calls `inputRef.current?.focus()` so the cursor
   lands in the prompt immediately after selecting a model.

## Diagnosis of the persistent NO_QUOTE
`fetchDailyOHLC` tries keyed providers (Massive/Tradier/Marketstack) first, then keyless Yahoo, then
Stooq. Probed in-process from this worktree:
- raw `fetch` to Yahoo → **200** (source is fine),
- `politeFetchJson` Yahoo (used by the app) → **429**, and Stooq → **200 but rate-limited body** →
  `fetchDailyOHLC` returns `null` here.

This host's IP is persistently rate-limited by the **free** sources, and this worktree has **no Massive/
Tradier key** — so the keyless fallback can't resolve locally. On the operator's box `fetchDailyOHLC`
hits **Massive (paid) first** and returns data without ever touching Yahoo, so the chat quote (and the
#174 review notional) resolve there. The fallback LOGIC is correct — verified by the raw-fetch probe,
the `fillMissingQuotesWithClose` unit test (#174), and code review.

## Files
- `src/lib/chat/orchestrator.ts` — `getQuote`: broker try/catch + keyless `fetchDailyOHLC` fallback +
  no `NO_ACCOUNT` hard-fail; import `fetchDailyOHLC`.
- `app/ui/assistant-console.tsx` — `inputRef` on the textarea; focus it on model-select change.

## Verification
- `npx tsc --noEmit` — clean.
- `npm test` — 1253/1253 passing.
- `npm run build` — clean.
- Live: chat round-trips 200. A live PRICE could NOT be confirmed locally — Yahoo 429s this IP and
  there's no Massive key in this worktree (see diagnosis). **Confirm on the Alpaca/Massive box** that
  "what is the price of VZ" now returns a number. The focus fix is a trivial ref+`focus()` (verified by
  build/compile; not separately e2e'd headless).

## Follow-ups / risks
- Free keyless price sources (Yahoo/Stooq) rate-limit datacenter IPs; the operator's Massive key is the
  reliable primary, so this only bites a keyless deployment. A more 429-resilient keyless tier is a
  possible later enhancement.
- Dollar-amount ("buy $150 of X") chat orders remain a separate, still-pending feature (see the
  2026-06-25 chat-markdown rollout).
