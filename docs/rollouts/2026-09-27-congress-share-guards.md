# Congress.Trade Share Guards (2026-09-27)

## 1. Context & Objective

Congress.Trade (CT) stopped ingesting its own market data and now relies **exclusively** on
Socratic.Trade (ST) for EOD prices and enrichment.  A four-worker audit of ST (board parent
`dc501c689caa4fdf8a934289be9cec99`) followed by a parallel audit **of CT's own repo** found that the
ST→CT push is fire-and-forget, and that CT performs **no validation** of what it receives.  That
combination is the subject of this change: three ways a wrong number can reach customer-facing
analytics in CT with nothing rejecting it and nothing alerting anyone.

## 2. Changes Made

All three guards are in `src/lib/congress-share.ts`, plus regression tests in
`test/congress-share.test.ts`.

### Guard 1 — a `close <= 0` can no longer be pushed (P0)

`ohlcBarsToCloses` previously validated only `Number.isFinite`.  A zero or negative close from any
of the L1–L9 provider cascade tiers would pass straight through, land in CT's `price_eod` table, and
feed CT's per-trade P&L with no rejection anywhere on the path.  Now rejected.

### Guard 2 — a future date can no longer mark a ticker fresh (P0)

CT derives a ticker's latest price date from `MAX(date)`.  One future-dated row therefore marks the
whole ticker fresh and **silently suppresses CT's own staleness watchdog**, which is the mechanism
that would otherwise have caught it.  A future date is always a provider or clock bug, never real
data, so it is now dropped.  The comparison uses the same UTC clock as `toBusinessDay` rather than a
local date, so the guard cannot misfire across a timezone boundary.

### Guard 3 — an HTTP 200 no longer counts as delivery (P0)

This is the important one.  CT's import handler returns:

```ts
return c.json({ ok: summary.errors.length === 0, ...summary });
```

— **HTTP 200 even when it rejected rows**, with `ok:false` and a populated `errors[]`.  ST read only
`res.ok`, so a partial import was indistinguishable from a clean one, and the nightly marker advanced
over rows CT never wrote.  `congressImportBodyError` now reads the body's verdict.  A body reporting
`ok:false` or any `errors[]` returns `ok:false` — deliberately **not** `skipped`, so the daily run
counts it in `failedPosts` and retries.  An **unparseable** 200 is also treated as failure: an
unreadable body is exactly the case where the marker must not advance on faith.

### Observability — dropped rows are no longer a silent coverage regression

`dropInvalidShareRows` filters schema-invalid rows and previously only `console.warn`ed.  Because CT
runs a **strict** schema (non-null `sentiment`/`buyFilings`/`owners`/`ratio` on insider and
short-volume rows), a null ST emits fails `safeParse` **on ST's side first** and never reaches CT at
all — so a schema drift shrinks delivered coverage with no error on either side.  Dropped counts now
also go to the service health store.

## 3. Decisions & Trade-offs

- **No contract changes.**  The shared `congress-trading-shared` schema is untouched; no new fields
  are transmitted and no field was removed.  Everything here is validation of data we were already
  sending.
- **An unparseable 200 is a failure, not a pass.**  This is deliberately conservative.  It means a
  transient CT-side response change makes the nightly run report failure and retry, rather than
  silently marking the day complete.  Failing loud is the correct trade for a path that feeds
  customer-facing P&L.
- **The 21-field enrichment backlog is explicitly NOT addressed here.**  The CT audit found **zero
  consumers** for all 21 tracked-but-unpushed fields — no column, no type, no UI slot anywhere in
  the CT repo.  Pushing them before CT has a consumer would be pure payload.  This is a
  positive finding: the earlier open question ("which of the 21 does CT need?") is now closed with
  the answer **none of them, yet**.
- **Shared-package version drift is noted, not fixed.**  The local checkout of
  `congress-trading-shared` is **2.6.0** while CT vendors and ST pin **2.7.0**.  That is a separate
  change against the shared package, not this PR.
- **CT-side gaps are not fixed here.**  CT has no inbound retry, no dead-letter, and no persisted
  import receipt, and it monitors only 3 of the 7 pushed streams (`insider`, `shortVolume`, `analyst`
  are unwatched — and each of those tables has exactly one writer, the import handler, so CT has no
  fallback for them at all).  Those belong in the CT repo.

## 4. Verification State

Run in the worktree `/Users/jay/apps/st-mm-ct-guards` on branch `minimax/ct-share-guards`
(off `origin/main` @ e3d868914).

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`scripts/land.sh` runs tsc → vitest → next build and aborts on any failure, so the landed PR is the
evidence.  Exact results are recorded in the PR body and the commit message.

## 5. Next Steps & Blockers

- **Still open on the ST side:** the stale-bar case.  When the L1–L9 cascade exhausts every provider,
  `history.ts` returns *stale* bars cached for 5 minutes and ST ships them as current.  The
  provenance stamp exists in ST but is not transmitted.  Not fixed here because the correct fix
  depends on whether CT should reject or merely display staleness — an owner/CT decision.
- **CT-side work worth filing against the CT repo:** persist an import receipt; return a `dropped`
  map for schema-filtered rows; add the 3 unwatched streams to the freshness watchdog; surface
  data age to customers (today `/market/prices` returns a stale price with no staleness signal);
  persist incoming `updatedAt`/`asOfTimestamp`, which are currently dropped and replaced with
  receive-time, so replaying month-old rows keeps the watchdog green.
- **Board:** audit parent `dc501c68`; the CT-contract findings to be filed as their own rows.
- **Parallel, in flight:** the equal-risk sizing cap and two other commits already sit on
  `minimax/equal-risk-sizing` / PR #3906 (authored by a concurrent MINIMAX session) — this branch is
  deliberately separate so the two do not contend.
