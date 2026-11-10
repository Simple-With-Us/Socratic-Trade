# R2 usage monitor: alert-basis fix for month-start false positives (2026-08-01)

## Context & objective

The R2 free-tier monitor (shipped 2026-07-31, PR #2312 + digest PR #2319)
fired **two false-positive alerts in its first night**: at 03:54 UTC
(storage 5.04 GiB at 0.52% of the month elapsed → linear pace ~970 GiB) and
at 09:53 UTC (storage 5.5 GiB + 12.7k Class A ops at 1.33% elapsed → pace
~413 GiB / ~957k ops). Both were the one-time initial litestream snapshot
upload into the new bucket projecting absurd month-end values — the exact
alert-fatigue pattern the owner must never train into.

## Root cause

`assessR2Usage` projected every metric as `mtd / elapsedFraction` with only a
~1-hour floor. At 0.5–1.3% of the month elapsed, any burst multiplies by
75–200x. Additionally, storage is a **stock** metric (a one-time bulk upload
is not a continuing rate) — linear pace is the wrong alert basis for it
entirely.

## Changes made

- `src/lib/r2-usage.ts` — each metric now carries `alertBasis`:
  - **storage → "absolute"**: alerts only when absolute MTD usage ≥
    threshold (5.5 GiB = 55% → quiet; 8 GiB = 80% → alert). Pace still shows
    in the digest/card for information, but never fires.
  - **Class A/B ops → "pace"**: pace alerts use a **0.2 elapsed-fraction
    floor** (`R2_OPS_PACE_ELAPSED_FLOOR`) so the projection multiplier caps
    at 5x — genuine runaway burn still fires (e.g. 200k ops in 7h → 1M
    projected = 100%), month-start noise doesn't (100k in 7h → floored 500k
    = 50%). Absolute MTD ≥ threshold also always alerts.
  - Alert titles/bodies now reflect the basis ("at N% of free tier" vs "on
    pace to exceed N%").
- `test/r2-usage.test.ts` — fixture gains `alertBasis`; two new tests:
  storage absolute-only semantics, ops 0.2 floor (burst suppression + real
  runaway still fires). 35 tests total in the r2/notify area, all green.

## Verification state

- `npx tsc --noEmit` clean; `npx vitest run test/r2-usage.test.ts
  test/notify-user-creds.test.ts` 35/35 green. Full suite + build delegated
  to required `verify` CI.
- Prod alert state currently holds storage+classA as "exceeded" from the
  false positives — on the first post-deploy check they transition back to
  "ok" and the owner receives **recovery** (✅) notifications, which doubles
  as organic end-to-end proof of the fix.

## Next steps & blockers

- None. If the owner wants storage pace alerting anyway (accepting the
  month-start noise), that's a one-line change to storage's alertBasis.

## Verification addendum (2026-08-01 19:54 UTC): proven in prod

- PR #2326 merged 15:39 UTC; deployed 17:11 UTC (one transient build failure
  at 16:04 self-recovered on retry; disk healthy at 34%/56% post-migration).
- First post-deploy check ran 19:54:08 UTC (watermark cleared manually to
  avoid a 3h wait): `exceeded: []` with storage at 6.3 GiB (59% absolute,
  quiet under the new basis) and Class A at 36.4k ops (floored pace ~18%).
- **2 recovery notifications fired and delivered via `push` AND `pushover`**
  — the latter being the first organic deliveries through the owner's new
  per-user Pushover app token (set in Settings at 19:34 UTC). The full loop
  — per-user credentials → per-user config → delivery — is proven.
- Next daily digest (~23:12 UTC) runs the new basis automatically.
