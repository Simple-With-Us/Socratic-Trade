# 2026-07-02 - console-macro

## Summary

- New `/console/macro` destination (parity-port Wave 2): the macro / market-regime
  board, ported from the legacy `app/ui/macro-panel.tsx` and improved. New files
  only, all under `app/console/macro/`:
  - `page.tsx` — the page: regime card, ~90d trend sparklines, five indicator tile
    sections (Rates & yield curve, Inflation & growth, Risk & volatility,
    Positioning & factor regime, Liquidity & economy), full-market breadth with
    top gainers/losers, market news, and a sources footer.
  - `indicators.ts` — pure indicator definitions. Every tile carries a
    plain-language "what this is" line plus, where a real threshold exists
    (inverted curve, VIX bands, HY-spread bands, SKEW, real rates, ERP, breadth,
    claims, …), a dynamic one-line interpretation of the CURRENT reading. Also the
    per-regime meaning copy, the "how the strategist uses the regime" bullets, and
    the trend-series definitions.
  - `trends.tsx` — token-only SVG sparklines for the trailing ~90-day histories
    (tenY, twoY, vix, hyCreditSpread, usd, wti) with polarity coloring (rising
    VIX/credit spread renders negative; direction-neutral series stay muted).
- Improvements over the legacy panel:
  - The current market regime is the page's hero: big label, severity chip
    (escalation / calm / normal / no data), plain-words meaning, the two
    classifier inputs (VIX band + 10Y−policy curve with inversion callout), the
    user's realized per-regime scorecard stat for the current regime (linked to
    Results), and a disclosure explaining exactly where the label changes
    strategist behavior (proposal stamping, thesis-x-regime sizing, Risk-Off/
    Crisis below-median-buy veto + crisis/inverted exposure cap, flip-triggered
    runs) — all verified against `src/lib/macro.ts`, `regime-watch.ts`,
    `policy.ts` (`crisisMaxOpeningExposurePct`), and `strategy.ts`
    (`selectThesisStat`, Rule 3 veto) before writing the copy.
  - Every tile is rendered (legacy hid missing ones); missing values show an
    em dash with "Not available in this snapshot." — never a fabricated number.
  - Honest unsourced-macro handling: when `macro.asOf === "unavailable"` (no FRED
    key AND the key-free VIX fetch failed) the FRED-derived tiles are blanked and
    a warning explains why, instead of rendering the backend's `DEFAULT_MACRO`
    placeholder constants as if they were data (legacy displayed them).
  - Owner UX standard applied: native `title` tooltip on every data point, label,
    chip, section header, link, and news row; `.con-row` hover/focus highlight on
    every tile/row; light + dark via `--con-*` tokens only; responsive 2/3/4-col
    grids for mobile.
  - Non-blocking error notice on the page when the snapshot poll is failing (last
    good data stays rendered), plus an honest empty state if the snapshot carries
    no `macroBoard` at all.

## Update (same day) — Codex P1: light-macro placeholders rendered as live data

Codex flagged (and the original Follow-ups section had recorded) that the
default no-FRED-key setup takes the backend "light macro" path: a live Yahoo
^VIX plus `DEFAULT_MACRO` placeholder constants for every other FRED field,
with `asOf` = today — indistinguishable client-side, so the page rendered
fabricated FRED numbers as real. Fixed with a coordinator-approved, narrowly
scoped `src/lib/macro.ts` change:

- `MacroData.fredSourced?: boolean` (optional, additive; documented semantics):
  `true` on the full FRED fetch, `false` on the VIX-only fallback and the
  fully-unavailable fallback, `undefined` on older payloads (callers fall back
  to the asOf heuristic). Set explicitly at all three `fetchMacroData` return
  paths and on `DEFAULT_MACRO`.
- `pruneMacro` now filters to string entries, so the meta flag NEVER reaches
  the LLM prompt payload — the strategy prompt stays byte-identical.
  `determineMarketRegime` untouched.
- Client (`app/console/macro/`): `macroSourcing(board)` returns per-source
  flags `{ fred, vix }`. When `fred` is false every FRED tile and FRED-derived
  metric (curve spreads, real rates, misery, ERP, VIX-term — vix3m is FRED)
  blanks to an em dash; the genuinely live VIX tile stays. The unsourced
  notice gains a VIX-only variant, and the regime hero shows a warn chip
  ("degraded — curve input unsourced") plus an explicit caution line when the
  label was computed from a placeholder curve.
- Tests: `test/cache-provenance.test.ts` asserts the flag on all three
  fetch paths; `test/macro.test.ts` asserts `pruneMacro` never leaks it
  (first-run and delta).
- Verified end-to-end on `next start`: `/api/dashboard` now ships
  `fredSourced: false, vix: 16.82 (live), asOf: today, regime: "Cautious
  (Inverted Curve)"` — the exact previously-invisible case.

**Recorded backend follow-up (not this PR):** the BACKEND still computes and
stamps the regime (and feeds the strategist) from placeholder curve constants
in this setup — the strategy-side fix (skip curve effects when unsourced, or
per-field sourcing on the prompt payload) belongs to the src/lib owner.

## Update 2 (same day) — P2: configured-but-failing FRED key marked as sourced

Follow-up finding on the P1 fix: `fredSourced: true` was set whenever a FRED
key was *configured*, but `fetchFredSeries` returns `undefined` per-series on
any failure (invalid key, 403/429 rate limit, network error) — so a bad key
built an all-placeholder payload flagged as sourced, and the 24h cache pinned
that false positive for a day. Fixed in `src/lib/macro.ts`:

- Sourcing is now derived from the DATA, not key presence: if zero of the 19
  series returned a value, the keyed path takes `fetchVixOnlyFallback()` — the
  exact same fallback as the no-key case (try live Yahoo ^VIX with
  `fredSourced: false` / `asOf` = today, else `asOf: "unavailable"`) —
  extracted into a shared helper so the two paths cannot drift. The honest
  flag is what gets cached, so the TTL cannot resurrect a false positive.
- The exception catch path also sets `fredSourced: false` explicitly.
- Tests (`test/cache-provenance.test.ts`): failing-key + Yahoo-up path (flag
  false, VIX live at the stubbed value, FRED fields at placeholders, cached
  re-read stays false) and failing-key + Yahoo-down path
  (`asOf: "unavailable"`, flag false).

Residual (unchanged, already recorded above): a PARTIALLY failing FRED fetch
still falls back per-series to placeholder constants while `fredSourced`
stays true — per-field sourcing remains the src/lib owner's follow-up.

## Update 3 (same day) — two more Codex P2s (applied by the coordinator session
## after this lane's build agent hit its usage-credit limit)

Both verified against the code and fixed in `src/lib/macro.ts`:

1. **Partial FRED payload no longer fabricates** (closes the residual above). A
   fetch where some series succeed and some fail set `fredSourced: true` while
   filling the failed fields from `DEFAULT_MACRO`, and the console's
   `fredSourced` gate then rendered every FRED tile as real — a single missing
   series became a fabricated live reading for the cache TTL. Fix: each field
   with no real value is now blanked to `""` (NOT a `DEFAULT_MACRO`
   placeholder). `fredSourced` stays true (a real keyed fetch did run and the
   present fields are real), and the console's existing `mv`/`mn` tile helpers
   already treat `""` as missing → `EM_DASH`, so each unsourced tile blanks
   per-field with NO client change while the series that resolved stay real.
   `determineMarketRegime` is NaN-safe (blank → not-finite → neutral), so no
   regime crash; and blanking is strictly more honest than the old placeholder
   fill for the regime input too.
2. **Failed user-key fetch no longer poisons the shared cache.**
   `fetchVixOnlyFallback` hardcoded `writeMacroCache("shared", ...)`, so a
   configured per-USER FRED key that failed wrote the blank VIX-only payload to
   the GLOBAL shared entry — another user, or the env/operator-key path, then
   read it for up to 24h before ever trying its own valid fetch. Fix: the helper
   now takes the caller's `scope` and writes there — a user-key failure caches
   PRIVATE (only that user sees the blank fallback); the no-key and env-key
   paths still resolve to `shared` via `macroCacheScopeForKeySource`, unchanged.

Tests (`test/cache-provenance.test.ts`): partial-fetch blanks the one failed
series to `""` while keeping the suite sourced and the resolved fields real; a
failed user-key fetch leaves the shared cache clean so a later env-key user
fetches fresh (`fredSourced: true`).

## Why

- Parallel-agent parity port of legacy dashboard features into the ground-up
  `/console` UI (foundation PR #321 already links `/console/macro` in the nav —
  this fills the dead link). The board explains the exact macro inputs the
  strategist conditions on, so the owner asked for per-indicator plain-language
  explanations and a prominent regime treatment rather than a raw tile dump.

## Files

- `app/console/macro/page.tsx` (new)
- `app/console/macro/indicators.ts` (new)
- `app/console/macro/trends.tsx` (new)
- `src/lib/macro.ts` (P1 fix: additive `fredSourced` flag + pruneMacro prompt
  exclusion — coordinator-approved exception to the no-src/lib constraint)
- `test/cache-provenance.test.ts`, `test/macro.test.ts` (P1 fix: flag + no-leak
  assertions)
- `STATUS.md`, `PLAN.md`, `docs/rollouts/2026-07-02-console-macro.md` (handoff)

No shared/console-foundation files were touched (hard constraint of the parallel
wave): no `console.css`, `nav.tsx`, `lib/api.ts`, no `src/lib/*`.

## Verification

- `npx tsc --noEmit` — clean (the known `test/alternative-data.test.ts`
  mockFetcher error did not reproduce in this worktree).
- `npm run lint` — 0 errors (284 pre-existing grandfathered warnings, none in
  `app/console/macro/`).
- `npm test` — 2241 tests / 234 files, all pass.
- `npm run build` — success; `/console/macro` present in the route manifest as ○.
- Runtime smoke: `next start` on :3111 with a scratch `DATABASE_URL`;
  `GET /console/macro` → 200; `GET /api/dashboard` inspected — live `macroBoard`
  shape confirmed (`regime: "Cautious (Inverted Curve)"`, macro/derived/signals
  keys as typed, empty `history`/`news` without a Massive key).
- After the P1 fix + merge of origin/main: full quartet re-run green — tsc clean,
  lint 0 errors, `npm test` 2242 tests / 234 files (one new pruneMacro test),
  build ok; runtime smoke on :3112 confirmed `fredSourced: false` + live VIX in
  the payload and `/console/macro` → 200. (One earlier test/build run failed on
  ENOSPC — the shared runner disk hit 99% from parallel agent builds, unrelated
  to the code; freed our own `.next` and re-ran clean.)

## Follow-ups

- ~~Backend "light macro" path is client-indistinguishable from fully sourced
  data~~ — FIXED via `MacroData.fredSourced` (see Update above). REMAINING
  backend follow-up for the src/lib owner: the strategist itself still receives
  placeholder FRED constants in its prompt and a regime label computed from a
  placeholder curve in the no-FRED setup; also, a full FRED fetch can still
  fall back per-series to a DEFAULT_MACRO constant when one series returns
  nothing (per-field sourcing would close that residual gap).
- Ticker chips in Market news and breadth movers are plain text (no
  `<SymbolButton>` drilldown) — the drilldown needs scan-quote wiring owned by
  the `/console/scan` agent; wire up after both waves land.
- Regime scorecard match relies on exact label string equality between
  `determineMarketRegime` output and persisted `entryMarketRegime` — true today;
  revisit if the label set in `src/lib/macro.ts` is ever renamed.
