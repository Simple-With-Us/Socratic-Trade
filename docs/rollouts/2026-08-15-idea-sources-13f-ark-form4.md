# Idea sources: 13F, ARK holdings, Form 4

## Context & Objective

Owner asked to run 13F, ARK daily holdings, and Form 4 as thoroughly as
possible and fully operational — official sources only, observe-only (no
auto-copy).  eToro CopyTrader stays off (no API access on this account).

## Changes Made

Form 4 now persists parsed ownership XML into `sec_insider_transactions`
(with ticker), optionally pulls watchlist CIKs in addition to the current
EDGAR feed, and always attaches the evidence card when rows exist.

New official connectors follow the phase-9 web-source pattern:

- SEC EDGAR 13F-HR for a curated superinvestor set (Berkshire, Pershing,
  Burry, Greenlight, Druckenmiller, Third Point, Tiger, Coatue, Icahn,
  ValueAct, Tepper, Baupost).  CUSIP→ticker via cached OpenFIGI plus ARK
  official CUSIPs.
- ARK K/Q/W/G/F/X daily holdings from `assets.ark-funds.com` CSVs,
  discovered via `ark-funds.com/api/fund/document-table/{id}`.

Both feed `getSymbolWebSignals` bulletins, strategy evidence cards,
Settings toggles, Scan Smart Money cards, and dashboard health.

Touched:

- `src/lib/db.ts` (migration 83), `src/lib/db-idea-sources.ts`
- `src/lib/web-sources/thirteen-f.ts`, `src/lib/web-sources/ark-holdings.ts`
- `src/lib/web-sources/sec.ts`, `src/lib/web-sources/sec-facts.ts`
- `src/lib/web-sources/index.ts`, `src/lib/web-sources/types.ts` (unchanged
  bulletin bag)
- `src/lib/source-settings-catalog.ts`, `src/lib/data-catalog.ts`
- `src/lib/strategy.ts`, `src/lib/strategy-prompts.ts` (`2.8.0`)
- `src/lib/dashboard.ts`, `app/dashboard-types.ts`
- `app/console/scan/smart-money.tsx`
- `test/idea-sources-13f-ark.test.ts`, `test/web-sources-sec.test.ts`,
  `test/strategy-prompt-safety.test.ts`
- `docs/phase-9-web-sources.md`, this rollout

## Decisions & Trade-offs

- Observe only.  No auto-follow of a 13F or ARK book.
- 13F ticker mapping is best-effort (OpenFIGI + ARK CUSIP cache).  Unmapped
  CUSIPs stay stored and do not invent a ticker.
- Form 4 watchlist pass is capped by `WEB_SOURCE_INSIDER_MAX_FILINGS` so a
  large watchlist cannot stampede EDGAR.
- Baupost CIK is the standard 13F filer id `0001061768`; if EDGAR returns
  empty the connector records 0 for that filer and keeps the others.

## Verification State

Focused vitest on the new parsers plus existing Form 4 suite.  Full land.sh
gate (tsc → test → build) before PR.

## Next Steps & Blockers

Follow-up: `docs/rollouts/2026-08-16-idea-sources-ops-fix.md`.  First
production refresh wrote 13F periods as accession CIKs, missed filers
whose information table is not named `form13fInfoTable.xml`, and locked
ARK at 0 rows for 24h by setting `fetchedAt` on an empty success.

## Zero-Code Findings

ARK moved CSVs to `https://assets.ark-funds.com/fund-documents/funds-etf-csv/…`
and expose them through `/api/fund/document-table/{fundId}`.  Old
`wp-content/uploads` paths 404.
