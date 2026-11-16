# 13F / ARK ingest ops fix

## Context & Objective

Owner asked for 13F, ARK, and Form 4 to be fully operational.  #2736
merged and auto-deployed, but the first production refresh was not
complete.

## Changes Made

Production receipts after #2736 (schema 83, live SHA `4bd3bcc0`):

- Form 4: 537 rows, 340 with ticker — working.
- 13F: 210 rows across 7 of 12 tracked filers.  `period_end` stored the
  accession CIK (`0001656456`) because EDGAR cover dates are `06-30-2026`
  and the parser only accepted `YYYY-MM-DD`.  Berkshire / Druckenmiller /
  ValueAct / Baupost information tables are unnamed (`56757.xml`,
  `form13f_20260630.xml`, …).  Third Point uses `<ns1:infoTable>`.
- ARK: official CSV fetch works from the prod container now, but the
  first run wrote `recordCount: 0` with `fetchedAt` set, so the 24h TTL
  would not retry.

Fixes:

- Namespace-tolerant cover + info-table tags; `MM-DD-YYYY` period dates.
- Pick any non-cover XML as the information table; never treat
  `form13f_YYYYMMDD.xml` as `primary_doc`.
- Do not persist a 13F row without a real quarter-end.  Purge leftover
  non-ISO `period_end` rows after a good ingest.
- Stay due when `okFilers` is incomplete or ARK `recordCount` is 0.
  Empty runs no longer stamp `fetchedAt`.

Touched:

- `src/lib/web-sources/thirteen-f.ts`
- `src/lib/web-sources/ark-holdings.ts`
- `src/lib/db-idea-sources.ts`
- `test/idea-sources-13f-ark.test.ts`
- `STATUS.md`, `docs/EFFORT-LOG.md`, this rollout,
  `docs/rollouts/2026-08-15-idea-sources-13f-ark-form4.md`,
  `docs/phase-9-web-sources.md`

## Decisions & Trade-offs

- Observe-only is unchanged.  No auto-copy.
- Incomplete 13F sets retry after the existing 1h scrape backoff, not the
  7d TTL, so a partial book cannot sit all week.
- iOS Scan still has no 13F/ARK cards; web Scan + strategy evidence is
  the operational surface.

## Verification State

`npx vitest run test/idea-sources-13f-ark.test.ts` — 12 passed.
Full `scripts/land.sh` gate before PR.

## Next Steps & Blockers

13F confirmed in prod after #2747: 413 rows, 12/12 `okFilers`, ISO
quarter-ends.  ARK follow-up: `docs/rollouts/2026-08-16-ark-csv-fallback.md`.

## Zero-Code Findings

Berkshire Q2 2026 information table is `56757.xml`.  Cover
`reportCalendarOrQuarter` is `06-30-2026`.  Third Point children are
`<ns1:cusip>` etc.
