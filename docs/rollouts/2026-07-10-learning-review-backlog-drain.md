# 2026-07-10 — Learning-review >80-item backlog drain (PR #1278 deferred finding #2)

## Summary

Fixed the daily learning-review job silently marking a large backlog of learned
lessons "reviewed" without ever auditing them. `buildLearningReviewContextPack`
(`src/lib/learning-review.ts`) sliced the reviewable items to the first
`MAX_REVIEW_ITEMS` (80) in an arbitrary pending-first order, and a "complete"
review then advanced the `learning_review:lastReviewedAt` marker to run-start
`now`. Because `evaluateLearningReviewTrigger` counts un-reviewed lessons as
those with `assertedAt`/`createdAt` **>** `lastReviewedAt`, every item past the
80-item budget (timestamp `<= now`) stopped counting toward BOTH the trigger's
`newCount` AND its `max-age` — so on a >80-item store those overflow lessons
could **never** be audited, defeating the feature's whole purpose (catching
corrupted learned lessons) for exactly the users who accumulate the most of them.

The fix:
1. **Sweep the OLDEST un-reviewed items first** within the budget (the ones
   closest to aging out unaudited), then fill any leftover budget with
   already-reviewed items (a re-audit against fresh system-history), newest-first.
2. Add **`truncated`** and **`reviewedThroughMs`** to `LearningReviewContextPack`.
3. Advance `lastReviewedAt` to `pack.reviewedThroughMs` instead of unconditional
   `now`: that is `now` on a non-truncated run, else **just below the oldest
   DROPPED un-reviewed item** — so the dropped (strictly-newer) items keep
   counting toward the trigger and are swept on later daily runs. The fingerprint
   is still stored on every fully-successful run (see "Why deferred" below).
4. Record `truncated` in the `learning_review_summary` audit for observability.

Net effect: a >80-item backlog now drains completely across successive daily
runs (80 oldest-un-reviewed per run), with **no item ever silently marked
reviewed**, and no extra LLM spend once drained.

## Why (decisions)

- **Why not just gate the marker on `!truncated`?** That was the trap that made
  this a non-one-liner (called out in the deferred-finding note). The fingerprint
  of the exact reviewed set is stored in the same `if (complete && failures === 0)`
  block. In **annotate** mode nothing is mutated, so the backlog only drains via
  the marker advancing. If a truncated run refused to advance the marker at all,
  annotate mode would re-show the same oldest-80 slice **and** never store the
  fingerprint, re-running the frontier-class LLM on an identical set every single
  day forever. The fix keeps advancing the marker (conservatively) and keeps
  storing the fingerprint on truncated runs, so the shown slice changes each day
  (drains) and identical sets still short-circuit.

- **Why `oldestDropped - 1ms`, not the "newest shown" timestamp?** Tie-safety.
  The trigger's test is strict `>`. If several items share the boundary
  millisecond and we set the marker to the newest **shown** timestamp, a dropped
  tie-mate at the same ms would be `<= marker` and get orphaned. Setting the
  marker to `oldestDropped - 1ms` guarantees every dropped item stays `> marker`
  (never orphaned); at worst a shown item tied with the first dropped item is
  harmlessly re-shown next run. It is also monotonic (`oldestDropped > lastReviewedAt`).

- **No regression to the 8da047aa max-age fix.** `reviewedThroughMs` only ever
  moves the marker to `<= now` — strictly **more** conservative than the previous
  unconditional `String(now)`. Non-truncated runs are byte-for-byte the old
  behavior (`reviewedThroughMs === now`), and the empty-pack "no-items" skip is
  untouched (marker still does not advance there). So the out-of-window learned
  rows that 8da047aa made reachable behave exactly as before; the shipped
  regression test for that path ("max-age fires for a LEARNED row older than the
  7-day window") still passes.

- **Kept the candidate SET identical** (all pending + learned within the 7-day
  pack window). Only the ORDERING and the marker math changed, so small stores
  (<= 80 items) see zero behavioral change beyond item order (which does not
  affect verdicts, the internally-sorted fingerprint, or coverage).

## Files

- `src/lib/learning-review.ts`
  - `LearningReviewContextPack`: added `truncated: boolean` and
    `reviewedThroughMs: number`.
  - `buildLearningReviewContextPack`: partition candidates into un-reviewed
    (`Date.parse(at) > lastReviewedAt`) sorted oldest-first and reviewed sorted
    newest-first; `items = [...unreviewed, ...reviewed].slice(0, MAX_REVIEW_ITEMS)`;
    compute `truncated` / `reviewedThroughMs`.
  - `runDailyLearningReview`: `learning_review_summary` audit now includes
    `truncated`; the `complete && failures === 0` block persists
    `lastReviewedAt = String(pack.reviewedThroughMs)` (was `String(now)`).
- `test/learning-review.test.ts`
  - New describe "backlog drain when reviewable items exceed MAX_REVIEW_ITEMS
    (deferred PR #1278 finding #2)": pack-truncation flag/marker assertions, a
    not-truncated control, and an `it.each(["annotate","decide"])` 200-item
    drain that asserts every seeded item is shown across exactly 3 daily runs
    with none silently marked reviewed and the store never mutated away.
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md` — In Progress row.
- `STATUS.md` — snapshot.

## Verification

All run with node@24 on PATH (`/opt/homebrew/opt/node@24/bin`) — the Mac default
`node` is v26 and mismatches the `better-sqlite3` ABI (see the mac-node26 trap).

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx tsc --noEmit                              # clean (0 learning-review errors; only the pre-existing alternative-data.test.ts mismatch)
npx vitest run test/learning-review.test.ts   # 34 passed (30 prior + 4 new)
npx vitest run                                # 314 files / 3338 tests passed
npx eslint src/lib/learning-review.ts test/learning-review.test.ts  # 0 errors
npm run build                                 # (see status; full Next.js build)
```

## Follow-ups / notes

- Base: built on MERGED `main` (`6f1aaf87`, PR #1278) — the target code landed
  earlier the same day, so this is a clean follow-up PR to main via
  `scripts/land.sh` (not stacked on the #1278 branch).
- This closes the LAST open #1278 deferred item. #1278 deferred finding #3
  (legacy-seed default-blob edge, `db-profiles.ts`) is a separate follow-up
  already IN PROGRESS by a peer MONET session
  (`monet/learning-review-legacy-seed-99138a`).
- Pre-existing, out of scope, NOT introduced here: when an out-of-window
  un-reviewed learned row (asserted > 7 days ago, excluded from the pack) coexists
  with within-window items, a completed review still advances the marker past it
  (marking it reviewed without individually showing it). That is the accepted
  8da047aa behavior — the max-age trigger's job is to force a sweep, and the
  out-of-window row itself is too old for the review window. This fix neither
  worsens nor addresses that; it only stops **in-pack** overflow items from being
  orphaned.

  **UPDATE 2026-07-10 (see addendum below): this note was wrong to call the
  above "accepted" without qualification — an adversarial re-review found it
  interacts with THIS fix's own deferral mechanism to reproduce the exact
  orphaning bug this PR was written to eliminate. Fixed same day; see below.**

---

## 2026-07-10 addendum — adversarial re-review found (and fixed) two adjacent orphaning gaps in this fix (MONET)

**Context.** After landing, this fix (and the separate #1278 finding #3 fix,
`db-profiles.ts`) were adversarially re-reviewed via a 4-lens/8-agent Workflow
(each lens finds candidate bugs; each candidate independently re-verified by a
second agent that tries to refute it by re-deriving and empirically running the
real code — not trusting the reporter's framing). Two real, empirically-reproduced
defects survived verification; a third candidate (the "isolated old row"
self-healing behavior quoted above) was investigated and confirmed to be
genuinely pre-existing/deliberate (traced to commit `8da047aa`'s own commit
message and this note's original text) — not a residual bug in this PR, so left
alone **except** that fixing the two real bugs below also closes it as a free
side effect (see below).

**Bug 1 — tied-timestamp boundary freeze (medium likelihood, high severity).**
`buildLearningReviewContextPack`'s truncation boundary picked `reviewedThroughMs
= atMs(unreviewed[MAX_REVIEW_ITEMS]) - 1`, assuming the `-1ms` trick was
"tie-safe" (a shown item sharing the boundary ms with the first dropped item is
just re-shown next run, harmless). That assumption silently breaks when the
ENTIRE tied cluster at the boundary is LARGER than `MAX_REVIEW_ITEMS` (e.g. a
backfill/batch writer reusing one shared `now()` across >80 rows, or several
synchronous `better-sqlite3` writes landing in the same JS clock tick): the
id-ascending tie-break deterministically re-selects the identical lowest-id 80
every run, `reviewedThroughMs` recomputes to the identical value forever, and
every item past the 80th (by id) is never shown — permanently. Empirically
reproduced: 90 rows sharing one exact timestamp force-run 20× at the same `now`
never advanced past showing the same 80.

**Bug 2 — multi-day drain vs. the 7-day pack window (high likelihood, high
severity — this is the one this note's original "pre-existing, out of scope"
paragraph missed).** This fix's own deferral mechanism protects a truncated
day's overflow items via `reviewedThroughMs` sitting just below them, promising
they'll be swept on a LATER run. But `buildLearningReviewContextPack` recomputes
the `LEARNED_WINDOW_DAYS` (7-day) window fresh, relative to the CURRENT `now`,
on every call — with no memory that an item was already a committed-to
candidate. If a deferred item's `assertedAt` sits close enough to the window's
trailing edge, the days it takes to reach its turn in the drain can push it
outside the window before that turn arrives: it silently vanishes from
`candidates`, and the next non-truncated successful review (of unrelated newer
items) advances `lastReviewedAt` past it via `reviewedThroughMs = now` — never
having shown it to the LLM. Empirically reproduced: 90 rows spanning
NOW-6.99d..NOW-6.50d; day 0 shows the oldest 80 and defers 10; day 1 (one
unrelated fresh row arrives) the 10 deferred rows are already outside the new
window and are silently dropped from the pack, and the (non-truncated) run
advances the marker past them — confirmed via LLM-stub instrumentation that
they were never shown across either run. This directly falsified this note's
own "no item ever silently marked reviewed" claim.

**Fix (one change closes both).** `buildLearningReviewContextPack`'s learned-row
filter now keeps a row if it's within the window OR it's UN-REVIEWED
(`assertedAt > lastReviewedAt`), regardless of age — mirroring
`evaluateLearningReviewTrigger`'s own window-free un-reviewed test (`8da047aa`,
which explicitly left the pack builder untouched/out-of-scope for that earlier,
narrower fix). This is a strict widening (no previously-included row is
dropped), safely bounded by the SAME truncation/oldest-first-sweep machinery
this PR already built and tested (an arbitrarily large backlog still paces at
`MAX_REVIEW_ITEMS`/day) — so it adds no new cost-scaling risk. It also closes
Bug 3 (the isolated-old-row case) as a natural side effect: an isolated old
un-reviewed row now always satisfies the un-reviewed clause, so it becomes a
legitimate candidate and gets genuinely reviewed instead of silently
self-healed away. The truncation boundary itself is separately hardened
(Bug 1): the cut now widens to the END of any tied-timestamp cluster straddling
`MAX_REVIEW_ITEMS`, guaranteeing the marker always advances to a genuinely new
value after a run touches one — at the cost of (rarely) showing more than the
budget in one call, which is the correct trade (a hard cap here would just
reintroduce the freeze).

**A bug in the fix itself, caught by its own new test.** The first draft of the
Bug 1 fix computed `truncated` correctly (false once widening consumes the
whole tied cluster) but then unconditionally re-sliced
`[...shownUnreviewed, ...reviewed].slice(0, MAX_REVIEW_ITEMS)` in the
non-truncated branch — silently dropping the very items just widened in for.
Caught immediately by the new regression test (90 tied items came back as 80).
Fixed: the non-truncated branch now only slices the REVIEWED filler to the
remaining budget (`reviewed.slice(0, max(0, MAX_REVIEW_ITEMS -
shownUnreviewed.length))`) and never re-slices `shownUnreviewed`.

**Tests.** Rewrote the "max-age fires for a LEARNED row..." test (it previously
asserted the OLD, now-incorrect behavior — a `"no-items"` skip it called
"Self-healing" — as intended; it now asserts the row is ACTUALLY reviewed).
Rewrote "never mutates rows the model was not shown" to construct its
already-reviewed row via a bootstrap review + pre-marker timestamp rather than
the window (which no longer excludes merely-old-but-un-reviewed rows). Added
two new describe blocks: tied-timestamp boundary (1 test) and multi-day drain
vs. window (1 test). Both fail against the pre-fix source (falsified) and pass
against the fix.

**Files.** `src/lib/learning-review.ts` (window-widening in
`buildLearningReviewContextPack`, tie-boundary widening + the
non-truncated-slice bugfix, updated comments on the trigger and the "no-items"
skip branch), `test/learning-review.test.ts` (2 rewritten + 2 new tests),
`STATUS.md`, `docs/EFFORT-LOG.md`, this addendum.

**Verification.** node@24. `npx tsc --noEmit` clean. `npx vitest run
test/learning-review.test.ts` 38/38 (36 prior + 2 new). Full `npx vitest run`
315 files / 3388 tests, all green. `npx eslint
src/lib/learning-review.ts test/learning-review.test.ts` 0 errors/warnings.
`npm run build` clean. Falsification: the rewritten + 2 new tests all fail
against the pre-fix source (3 failures), confirming each pins a real defect;
the untouched "never mutates" test passes both before and after (its premise
doesn't depend on this change).

**Provenance.** Found via an adversarial 4-lens/8-agent Workflow re-review
launched specifically to verify PR #1328's fix was actually correct before
reporting deferred finding #2 as closed (not a user-reported bug or CI
failure) — see `/workflows` history for the review/verify agent transcripts.
