# 2026-06-25 — Chat Markdown rendering + keyless quote fallback (fixes the MAX_SAFE_INTEGER block)

Branch `feat/chat-md-quotes-notional` (throwaway worktree `~/apps/trading-ag13`, off `origin/main`).

## Symptoms (from the operator)
- Chat showed raw Markdown (`**bold**`, `1.` lists rendered literally).
- Drafting even **0.5 shares of XOM** (or 1 LYB) was "Blocked by policy" with an absurd
  `est. $9,007,199,254,740,991` and a wall of cap violations.
- The assistant kept saying "the quote service isn't returning data."

## Root cause
`$9,007,199,254,740,991` is exactly `Number.MAX_SAFE_INTEGER` — the "can't size it, fail closed"
sentinel `estimateReviewNotional` returns for an OPENING order when **no price is available**. Both the
chat `get_quote` tool and the pre-trade notional review get their price from
`AlpacaBrokerGateway.getEquityQuotes`, which only read Alpaca's latest **bid/ask** (`bp`/`ap`). Those
are 0/empty outside market hours and on the free IEX tier → no price → sentinel → every cap trips. The
gateway had **no fallback**.

## Fixes
1. **Keyless quote fallback** (`src/lib/alpaca.ts`). New exported helper `fillMissingQuotesWithClose`
   fills any symbol the broker left unpriced (missing or `price <= 0`) with a recent daily close from
   `fetchDailyOHLC` (keyless Yahoo, works anytime), tagged `provider: "yahoo-finance-delayed"`. Wired
   into `getEquityQuotes` after the Alpaca call, so it fixes BOTH the chat quote and the review
   notional in one place. The gateway now stores `userId` (for `fetchDailyOHLC`'s cache tiers).
2. **Honest no-price UX** (`app/api/proposals/from-draft/route.ts`). If the review still can't price an
   order (sentinel), the response now returns a single clear reason — "Couldn't get a current price for
   X right now …" — and `estimatedNotional: undefined`, instead of the multi-quadrillion notional + cap
   wall.
3. **Markdown rendering** (`app/ui/markdown.tsx`, `app/ui/assistant-console.tsx`). Assistant messages
   now render full Markdown (CommonMark + GFM: bold/italic, ordered/unordered lists, headings, links,
   inline/block code, tables, blockquotes) via `react-markdown` + `remark-gfm`, styled to match the UI.
   No `rehype-raw`, so embedded HTML/script in model output is escaped (XSS-safe). User messages stay
   plain text.

## Deferred (explained to operator, not in this PR)
**Dollar-amount ("buy $150 of X") orders through chat.** The broker + review layers already support it
(`estimateReviewNotional(dollarAmount)`, Alpaca `orderArgs.notional`, `TradeProposal.dollarAmount`,
`EquityOrderInput.dollarAmount`), but the chat `draft_order` tool schema still requires a share `qty`,
and wiring notional through draft → proposal → **execution** (where many code paths assume a share
quantity) warrants its own focused PR with order-path tests. Tracked as a follow-up.

## Files
- `src/lib/alpaca.ts` — `fillMissingQuotesWithClose` (exported); `getEquityQuotes` fallback; gateway
  stores `userId`; import `fetchDailyOHLC`.
- `app/api/proposals/from-draft/route.ts` — honest no-price decision when the notional is the sentinel.
- `app/ui/markdown.tsx` — NEW Markdown component (react-markdown + remark-gfm, styled, HTML-safe).
- `app/ui/assistant-console.tsx` — render assistant bubbles via `<Markdown>`.
- `package.json` — `react-markdown`, `remark-gfm`.
- Tests: `test/alpaca-quote-fallback.test.ts`.

## Verification
- `npx tsc --noEmit` — clean.
- `npm test` — full suite green (1253).
- `npm run build` — clean.
- Live (throwaway `next dev -p 4199`, torn down): dashboard `GET /` 200 (react-markdown SSR ok); chat
  `{model:"mock"}` round-trips 200. NOTE: the Alpaca quote fallback can't be exercised locally (this
  worktree runs Test mode, not an Alpaca account) — it's covered by the helper unit test + reasoning;
  confirm on the Alpaca box that 0.5 XOM now prices and is no longer blocked by the sentinel.

### Markdown testing note
A deterministic render test (renderToStaticMarkup over `<Markdown>`) was written and passed in
isolation, but the repo's transformer (rolldown-vite/**oxc**) honors tsconfig `jsx: "preserve"` and
cannot transform an imported `.tsx` inside vitest — and overriding via `esbuild.jsx` is ignored when
oxc is active. No component tests exist in this repo by convention (logic-only `.ts`), so the test was
dropped rather than fiddle with the shared transformer config in a land-blocking path. Markdown is
verified instead by: the production build (which compiles `markdown.tsx`), the live SSR smoke (dashboard
200), and react-markdown's documented behavior (no `rehype-raw` → raw HTML/script escaped).

## Follow-ups / risks
- The fallback uses a recent daily CLOSE (delayed), labeled `yahoo-finance-delayed` — fine for sizing/
  notional and "what's X at", but it's not a live tick. Intraday is a later enhancement if needed.
- Dollar-amount chat orders (above).
