# 2026-06-17 — Share-quantity precision: full in the backend, "whole-number-or-3-sig-figs" on screen

## Summary
Finalized the share-quantity number policy app-wide and cleaned the working tree of
iCloud sync-conflict duplicate files.

1. **Display rule (`formatQuantity` in `src/lib/money.ts`).** Share / non-currency
   quantities now render as **3 significant figures OR every digit of the whole
   number, whichever is larger**, comma-grouped, trailing zeros stripped:
   - `12,489.242 → "12,489"` (all 5 integer digits preserved, *not* truncated to a
     3-sig-fig `1.25e4`)
   - `1,234.56 → "1,235"`, `12,345.6 → "12,346"` (grouped)
   - `0.167333 → "0.167"`, `0.5 → "0.5"`, `1.5 → "1.5"`, `12.489 → "12.5"`
     (≤3 sig figs for sub-100 values, no fabricated trailing zeros)

   Implementation: `sigFigs = max(3, integerDigitCount)`, then
   `Number(value.toPrecision(sigFigs)).toLocaleString("en-US",{maximumFractionDigits:20})`.
   This replaces the previous branch that did `Math.round` (no grouping) for
   `abs >= 1000` and a flat `toPrecision(3)` below it.

2. **Backend precision unchanged (already full).** Records keep full double
   precision — fills are SQLite `REAL`, `recordFillFromProposal` stores
   `quantity = notional/price` at full precision, and `robinhood.ts toMcpOrder`
   sends `quantity.toString()` (no rounding; only currency fields are `toFixed(2)`).
   The earlier `tax.ts` `toFixed(4)` truncation was already removed (commit
   `2735208`). So a 0.167333-share buy is *stored* as 0.167333 and *shown* as 0.167.

3. **Working-tree hygiene.** Removed 22 stale `"<name> 2.<ext>"` iCloud
   conflict-copy files and added a `.gitignore` block matching `* [0-9].<ext>` so
   these sync artifacts can never clutter `git status` or be swept into a commit.
   (The repo lives under `~/Documents`, which is iCloud-synced; deleting the copies
   is futile because the daemon re-materializes them — ignoring is the durable fix.)

## Why
The user's spec: "if the share number is 12,489.242 shares then I'd expect it to
preserve all digits of the whole number … and display only 3 significant figures or
all digits of the whole number (whichever is larger) … display 12,489 and preserve
in the back end 12489.2." Backend already kept full precision; the display formatter
was the only piece that needed to change (it was rounding large counts without
grouping and was capped at 3 sig figs).

## Files
- `src/lib/money.ts` — rewrote `formatQuantity`.
- `test/dashboard-feed.test.ts` — updated `formatShareQuantity` expectations to the
  grouped, whole-number-preserving outputs (`1234.56 → "1,235"`, `12345.6 →
  "12,346"`, added `12489.242 → "12,489"`).
- `.gitignore` — ignore iCloud `"<name> 2.<ext>"` conflict copies.

## Verification
- `node -e` sanity check of the formatter against all spec cases — pass.
- `npx tsc --noEmit` — clean.
- `npm test` — **136 passed (18 files)**.
- (`npm run build` re-checks types; run before merge.)

## Follow-ups
- None for this change. Next per the Phase 10 plan: **B2** — full EvidenceDigest for
  chosen AND skipped candidates (extend `signal_snapshot` + enrich
  `candidates_considered`).
- Branch `phase-10` fast-forward-merges cleanly into `main` (it is a strict
  descendant of both `web-sources` and `main`); this supersedes the old
  "merge web-sources → main" item (F3).
