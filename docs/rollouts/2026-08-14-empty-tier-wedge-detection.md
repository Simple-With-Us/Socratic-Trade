# 2026-08-14 — Empty compaction level is a wedge verdict, not "normal"

## 1. Context & Objective

Deep compaction (Litestream level 2) has produced nothing in the production
replica since roughly 2026-08-08.  The per-tier backup monitor watched it the
whole time and reported no problem, because the terminal stage of a compaction
wedge is not a *frozen* level — it is an *empty* one, and `fileCount <= 0` was
classified as `not-observable` / `no-activity-recorded` with the detail "This is
normal for a level Litestream has not needed to produce."

This change makes that state visible.  It does NOT fix the wedge — see
"Root cause" below, which remains the owner's to act on.

### Production ground truth (evidence)

Read from production on 2026-08-14T03:46Z.  The persisted remote-inventory
snapshot (`durable_state`, namespace `litestream`) read:

```
status: "ok",  levelErrors: {},  skippedReason: null
level 1: fileCount 2032, newest 2026-08-14T03:46:05Z, txid 00000000000468d8
level 2: fileCount 0,    newest "",  txid null
level 3: fileCount 0,    newest "",  txid null
level 9: fileCount 2,    newest 2026-08-14T00:00:06Z, txid 0000000000043200
```

Levels 2 and 3 hold ZERO objects.  The listing SUCCEEDED — this is not a
visibility failure.  Level 1 is healthy and actively advancing (newest object
~4 minutes old, 2,032 files piled up).  Level 9 (daily snapshot) is current.

Consequence before this change: `/api/health` returned
`litestreamDegradedReasons: []`, the tier carried no degraded flag at all, and
deep compaction being dead was invisible.

### Root cause — NOT fixed here, owner's to fix

Every Coolify rolling deploy briefly runs TWO litestream writers against the
same B2 prefix.  Litestream 0.5.12 has no fencing, so the two writers emit
level-1 objects with different `MinTXID` and identical `MaxTXID`;
`ltx.IsContiguous` requires `max > prevMax`, so the level-1 -> level-2 promotion
fails permanently.  Repair requires a Coolify deploy-strategy change plus a
one-time B2 delete.  This PR only makes the failure visible — it changes no
deploy configuration, touches no bucket, and cannot clear the wedge.

## 2. Changes Made

A third tier state, `"empty"`, sitting between `"known"` (measured, with
numbers) and `"not-observable"` (structurally cannot see it).  A successful
listing that returns zero is a MEASUREMENT and now carries an auditable verdict
instead of a reassurance.

### The predicate

Applies only to a level whose remote listing SUCCEEDED and reported
`fileCount === 0`.  Everything else keeps its existing path.

Mechanism it rests on, read from litestream v0.5.12 rather than assumed:

- `Store.monitorCompactionLevel` fires on every interval boundary.  Defaults
  from `DefaultCompactionLevels` (L1 30s, L2 5m, L3 1h) are in force because
  `litestream.coolify.yml` sets no `levels:` key; level 9 is `snapshot.interval:
  24h`; level 0's 60s is that file's replica `sync-interval`.
- `Store.CompactDB` has **no volume or accumulation threshold**.  It skips on
  exactly two conditions: it already ran this boundary, or
  `srcInfo.MaxTXID <= dstInfo.MinTXID`.  An EMPTY destination has
  `dstInfo.MinTXID == 0`, so that second test can never hold while the feeder
  has files.
- `Compactor.Compact` uses `srcLevel = dstLevel - 1` literally.

So an empty level whose immediate feeder is non-empty is not "waiting for enough
input".  It has been offered work on every tick and produced nothing.

Ordered classification for a measured-empty level N:

1. **Internally inconsistent listing** (files but no readable timestamp, or zero
   files yet a timestamp) -> `not-observable` / `remote-inventory-inconsistent`.
   Never "normal".
2. **Whole-prefix guard** — if every remote level {1,2,3,9} lists empty, all four
   report `not-observable` / `remote-inventory-empty`.  A successful listing
   returning nothing anywhere is a wrong bucket/path/credential or a brand-new
   prefix, not four simultaneous independent wedges.
3. **Feeder unobservable** -> `not-observable` / `feeder-unobservable`.
4. **Feeder also empty** -> if the feeder's own verdict is `wedged` or
   `upstream-wedged`, this level is `empty` / `upstream-wedged` (degraded, copy
   names the feeder as the thing to fix); otherwise `empty` / `expected` /
   `upstream-empty`.
5. **Feeder idle** — feeder's newest object older than the FEEDER's own
   threshold, measured against the snapshot's `collectedAt` -> `empty` /
   `expected` / `input-idle`.
6. **Superseded** — some higher level **that actually consumes this one** has
   already advanced past the feeder's newest txid -> `empty` / `expected` /
   `superseded`.  This is the legitimate "drained upward, then retention pruned
   the sources" case.  Only levels with a non-null `LITESTREAM_FEEDER_TIER` are
   eligible as evidence; see the level-9 exclusion below, which is the single
   path capable of silencing this whole rule.
7. **Backlog span** —
   `floor((feederFileCount - 1) / 2) * feederProductionIntervalSeconds`.
   `> thresholdSeconds(N)` -> `empty` / `wedged`, degraded.  Otherwise
   `empty` / `expected` / `within-threshold`.

Level 9 has no feeder (`CompactDB` shortcuts to `db.Snapshot`), so level 1's
span is borrowed strictly as a replica-AGE lower bound, gated at level 9's 30h
threshold, and the copy says so.

### Applied to the ground truth above

- L1: 2,032 files -> existing age/txid path, fresh, healthy.
- L2: empty, feeder L1 non-empty and 5s old.  Span =
  `floor(2031/2) * 30s = 30,450s = 8h27m` > 7,200s (2h) -> **WEDGED**, degraded.
- L3: empty, feeder L2 empty and wedged -> **upstream-wedged**, degraded, copy
  points at level 2.
- L9: 2 files, age 3.8h <= 30h -> known, healthy.

Today the same input yields zero degraded reasons.

### Files touched

- `src/lib/runtime-health.ts` — new `LITESTREAM_LEVEL_PRODUCTION_INTERVAL_SECONDS`,
  `LITESTREAM_FEEDER_TIER`, `LITESTREAM_BACKLOG_SPAN_SAFETY_DIVISOR`; new
  `"empty"` variant with `verdict`/`reason`/feeder evidence fields;
  `no-activity-recorded` deleted and three honest reasons added
  (`remote-inventory-empty`, `remote-inventory-inconsistent`,
  `feeder-unobservable`); `fileCount` plumbed through `TierObservation`;
  `isLitestreamTierDegraded()` and `describeDuration()` exported;
  report gains `degradedReasons: string[]`; `observedTiers` counts empty levels.
- `src/lib/litestream-remote-inventory.ts` — `summarizeLitestreamLtxPayload` no
  longer zeroes `fileCount` when no entry carried a parseable timestamp.
- `app/api/health/route.ts` — new `checks.storage.litestreamTiersDegraded` and
  `checks.storage.litestreamTierDegradedReasons`; new
  `litestream_tier_<N>_empty_wedged` operator alert.
- `app/admin/backups/backup-status-client.tsx` — `"empty"` arm in the parser,
  "Wedged"/"Empty" status labels, neg/warn tones, explanatory copy.
- `test/runtime-health.test.ts` — new "Litestream empty-level wedge detection"
  suite (8 cases); the pre-existing mixed-listing test updated (it asserted the
  bug).
- `test/connection-health-routing.test.ts` — route-level reproduction of the
  production shape.
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

## 3. Decisions & Trade-offs

**Two design proposals were reconciled.**  Where they disagreed:

1. **Duration evidence: backlog span (proposal A) over a durable `emptySince`
   clock (proposal B).**  `emptySince` is the more direct measurement, but it
   cannot be evaluated from a single snapshot — every consumer of
   `assessLitestreamTierFreshness` holds exactly one — and it delays first
   detection by at least the threshold plus a collection cycle, i.e. this wedge
   would stay silent for another 2.5 hours after deploy.  The span bound derives
   the same duration claim from data already collected, from litestream's own
   one-file-per-boundary guarantee, and fires on the first health check.  The
   trade-off is real and stated: the span bound is weak when the feeder retains
   few files, so a low-write replica can hide a wedge for a long time.
   `emptySince` remains a good future addition, not a replacement.

2. **A raw file-count threshold was rejected outright.**  The healthy replica
   measured 5,635 level-1 files on 2026-08-12; the wedged one measures 2,032 on
   2026-08-14.  The count went DOWN, because `EnforceSnapshotRetention` prunes
   every level regardless of health.  Any "level 1 > N files means backlog" rule
   would have been calibrated backwards.  Converting the count to wall clock via
   the interval-boundary guarantee is the part that is actually invariant.

3. **Level 3 degrades too, as `upstream-wedged`.**  Both proposals suppressed it
   entirely (proposal A: `not-observable` / upstream-empty; proposal B: `empty`,
   not degraded) to keep one root cause to one page.  Rejected: `degraded` on a
   tier means "this tier is not in a healthy state", not "this tier is the root
   cause", and an hourly rollup level holding zero objects IS a real gap in the
   replica.  Cause attribution belongs in the copy, and it is there — level 3's
   detail says "Fixing level 2 is what restores this one; it is not a second,
   independent fault."  The distinct `verdict` value keeps the two
   machine-distinguishable, and the alert keys differ.

4. **`LITESTREAM_BACKLOG_SPAN_SAFETY_DIVISOR = 2`** is the only number chosen for
   margin rather than derived.  It targets one specific known inflation: the
   rolling-deploy double writer (this incident's own root cause) can emit two
   level-1 objects for the same boundary.  Cost is halved sensitivity — 8h27m
   reported against a true minimum of ~16h55m — which is cheap against a 2h gate
   and is the right direction of error.

5. **No new threshold dials.**  The span gate reuses
   `LITESTREAM_TIER_STALE_AFTER_SECONDS`, and the feeder-advancing window reuses
   the FEEDER's entry in the same map.  "Has this level failed to produce for
   longer than it credibly could in health?" is the same question whether the
   last output was three hours ago or never existed; one knob per tier means two
   rules can never silently disagree.

6. **Feeder freshness is graded against the snapshot's `collectedAt`, not
   `nowMs`.**  A snapshot may legitimately be up to 90 minutes old; grading its
   contents against request time would drift a real wedge into "expected" purely
   as the snapshot ages — a miss manufactured by collector lag.  Snapshot
   staleness is already policed separately by
   `LITESTREAM_REMOTE_INVENTORY_MAX_AGE_SECONDS`.

7. **The collector fix is a precondition, not a nicety.**
   `summarizeLitestreamLtxPayload` returned `fileCount: newestAt ? fileCount : 0`,
   so a listing of real objects none of which carried a parseable timestamp
   collapsed to zero — the collector could MANUFACTURE the empty state out of a
   parse problem.  With emptiness now load-bearing, that had to go first.

8. **`litestreamDegradedReasons` is left alone.**  It is typed
   `LitestreamDegradationReason[]` and is produced solely by
   `assessLitestreamRuntimeHealth` grading the IPC daemon signal.  Tier verdicts
   travel in the new `litestreamTierDegradedReasons` so neither assessor muddies
   the other.

9. **`/api/health` `ok` does NOT flip.**  A 503 restarts the container, and a
   restart cannot clear a wedged B2 compaction — worse, the root cause is the
   rolling deploy's double-writer window, so a restart loop would deepen the
   damage.  `checks.storageDegraded` goes true; the page is a Pushover operator
   alert.

10. **An empty LOCAL `ltx/0` still reports `not-observable`.**  Level 0 has no
    feeder and is not collected remotely, so there is no evidence to grade it
    against.  Deliberately out of scope.

11. **`supersededBy` may only consult levels that actually consume the level
    under test** — i.e. levels whose `LITESTREAM_FEEDER_TIER` is non-null.  This
    was caught in adversarial review of the first draft of this branch and is
    the one code path capable of SILENCING the alarm the branch exists to add,
    so the evidence is recorded rather than summarized.  The first draft scanned
    every higher level, which included level 9.  Level 9 is a whole-DB snapshot —
    `Store.CompactDB` shortcuts it straight to `db.Snapshot`, a fact this file's
    own comments already recorded — so its txid tracks the LIVE DATABASE, not
    level 3, and it carries no information about whether level 2 compacted.
    Reproduced by running the real function on the exact 2026-08-14 production
    snapshot with ONE field changed: level 9's txid moved from
    `0000000000043200` to level 1's `00000000000468d8`, which is its normal value
    in the window right after each daily snapshot.  Level 2 flipped from
    `empty/wedged/backlog-past-threshold degraded=true` to
    `empty/expected/superseded degraded=false`, `report.degraded` went true ->
    false, `degradedReasons` went 2 -> 0, and the panel printed the factually
    false sentence "Level 9 has already advanced to transaction
    00000000000468d8, so this level's objects were promoted rather than lost."
    Exposure was bounded (a short once-daily window, self-healing on the next
    30-minute collection), so it delayed rather than permanently suppressed —
    but a comforting default emitted as a false factual claim is exactly what
    this branch exists to eliminate.  Two tests now pin it: the level-9 case
    against the production shape, and a positive case proving `superseded` still
    fires where it is TRUE (level 3, which really is fed by level 2, advanced
    past what level 1 holds).  Note the consequence: level 3 can now never be
    `superseded`, which is correct — nothing consumes level 3.

### Known residual false-alarm path

If `litestream.coolify.yml` ever configures `levels:` explicitly such that a
level is genuinely never produced, that level would look permanently wedged
while its feeder stays healthy.  Mitigated the same way
`LITESTREAM_COMPACTION_TIERS` already is — the interval and feeder maps carry an
explicit lockstep-coupling comment — and the alert names the level number so an
operator can remove it from the list in one edit.  Flagged rather than hidden.

### Known missed-alarm paths

- An empty **level 1** (feeder is level 0, whose retention keeps its count small)
  is covered with less headroom than the other levels, but is NOT weakly covered
  at production's current shape — the earlier draft of this note said "weakly"
  and that understated it, so the measured numbers are recorded here to stop
  anyone loosening the rule on a false premise.  Level 1's gate needs
  `floor((N-1)/2) x 60s > 4h`, i.e. **482** level-0 files; production's `ltx/0`
  holds ~1,078, giving a span of 8h58m against a 4h threshold — roughly **2.2x**
  margin.  The real caveat is conditional, not current: a machine whose level-0
  retention were cut to under ~482 files would fall below the gate.
- A **low-write replica** accumulates feeder files slowly, so the span bound is
  weak and a wedge can stay under threshold for a long time.  Structural: fewer
  measurements means a weaker lower bound, and inventing a tighter one would be
  fabricating precision.
- A wedge that begins during an **idle stretch longer than the feeder's own
  threshold** reports `input-idle` and stays quiet until writes resume.
- **Content corruption** — objects that exist, are contiguous, and are
  unrestorable — is invisible to any freshness rule.  That is what
  `validation: interval: 1h` plus `scanLitestreamRuntimeLogFile` cover, and both
  stay wired.
- The **frozen** stage (level present, timestamp stuck) belongs to the existing
  age/txid rule, not this one.  The two are a pair.  Chronologically production
  sat frozen from ~2026-08-08 until retention pruned level 2 to zero; if the
  frozen stage had alarmed, the empty stage would never have been reached.

### Honest limit on what the alert can claim

The wedge has been live for roughly six days.  The monitor never measured that,
so the copy says only what the snapshot supports: "level 1 holds 2,032 file(s)
spanning at least 8h27m of compaction boundaries."  Backdating to 2026-08-08 to
make the alarm louder would be the same class of fabrication as the reassurance
being removed.

## 4. Verification State

Run from `/Users/jay/apps/trading-monet-tierwedge` (branch
`monet/empty-tier-wedge`, merged with `origin/main` @ `637939af`) with
`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`.

```
npx tsc --noEmit    # exit 0, no output
npm test            # 568 files passed | 1 skipped (569)
                    # 6650 tests passed | 51 skipped (6701), 440.91s
npm run build       # exit 0, full route table emitted
npm run lint        # exit 0 — 758 problems (0 errors, 758 warnings),
                    # all grandfathered; zero warnings in the touched files
```

Each required test was confirmed to FAIL against current `main`, by stashing
ONLY the four source files (`src/lib/runtime-health.ts`,
`src/lib/litestream-remote-inventory.ts`, `app/api/health/route.ts`,
`app/admin/backups/backup-status-client.tsx`) and re-running:
**9 failed / 65 passed** across the two touched test files, including

- `calls the 2026-08-14 production shape a wedge instead of normal` — FAILED on
  main (`expected { tier: '2' } to match object { state: 'empty' }`)
- `does not alarm on a brand-new replica ...` — FAILED on main
- `does not alarm on an idle database whose feeder has gone quiet` — FAILED
- `keeps a stale inventory honest instead of converting it into a wedge` —
  FAILED on main (state was already honest there; the new `degradedReasons`
  contract was not)
- `keeps a failed level listing honest instead of converting it into a wedge` —
  FAILED
- `/api/health flags an EMPTY deep-compaction level as wedged ...` — FAILED

The three tests added in review round 2 were fail-first checked the same way:

- `does not let the daily snapshot level explain away an empty compaction level`
  — FAILED against the branch's own first draft with
  `expected reason 'backlog-past-threshold' / degraded true, received
  'superseded' / degraded false`.  This is decision 11 above.
- `still calls an empty level superseded when the level that consumes it has
  advanced` — the positive counterpart, proving the fix narrowed the rule rather
  than deleting it.
- `keeps the file count when no entry carried a parseable timestamp` — FAILED
  against `origin/main`'s `summarizeLitestreamLtxPayload`
  (`fileCount: 0`, expected `2`), giving decision 7 its own direct unit test
  instead of only indirect coverage through the grader.

## 5. Next Steps & Blockers

1. **OWNER: fix the root cause.**  Stop rolling deploys from running two
   litestream writers against one B2 prefix (a Coolify deploy-strategy change),
   then delete the colliding level-1 objects so `ltx.IsContiguous` can advance
   again.  Until then this PR's only effect is that the failure is now loud.
2. Expect `litestream_tier_2_empty_wedged` and `litestream_tier_3_empty_wedged`
   Pushover alerts on the first health check after deploy, and a red ATTENTION
   NEEDED chip on `/admin/backups`.  Both are correct.
3. Consider adding a durable `emptySince` field to the collector as a second,
   independent duration signal once the wedge is repaired — it covers the
   low-write-volume case the span bound is weak at.
4. Consider whether the FROZEN stage should have alarmed before retention emptied
   level 2.  If it did not, the age/txid rule has its own gap and this fix only
   catches the later stage.

## 6. Zero-Code Findings

None — this note accompanies code.
