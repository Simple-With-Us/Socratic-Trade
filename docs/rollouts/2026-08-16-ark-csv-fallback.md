# ARK official CSV fallback

## Context & Objective

#2747 made 13F operational.  ARK stayed at 0 rows because
`ark-funds.com/api/fund/document-table/{id}` is a Cloudflare challenge
(HTTP 403 "Just a moment") from the prod box, and `politeFetchText`
threw before the official `assets.ark-funds.com` CSV fallback ran.

## Changes Made

- Resolve the CSV URL via the document table when it works; on any
  failure use the official `funds-etf-csv` filename (already verified
  200 from the prod container with no UA).
- Send a browser UA on ARK fetches.
- Empty ARK books retry after 2 minutes instead of the 1h scrape
  backoff.

Touched: `src/lib/web-sources/ark-holdings.ts`,
`test/idea-sources-13f-ark.test.ts`, `STATUS.md`, `docs/EFFORT-LOG.md`,
this rollout.

## Decisions & Trade-offs

Official fallback filenames are the same paths ARK publishes today.
If they rename a file the next successful document-table fetch updates
the href; until then the last known official name is used.

## Verification State

Prod: `assets.ark-funds.com/.../ARK_INNOVATION_ETF_ARKK_HOLDINGS.csv`
returns 200 / 6338 bytes.  Document-table returns 403 CF interstitial.

Focused vitest + `scripts/land.sh` before PR.

## Next Steps & Blockers

Confirmed on live `f0fd2b70`: `ark_holdings` 222 rows, 6 funds as-of
2026-08-14.  #2735 closed.

## Zero-Code Findings

`assets.ark-funds.com` is not behind the same CF challenge as
`www.ark-funds.com`.
