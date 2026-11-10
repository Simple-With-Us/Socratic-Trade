# 2026-08-17 — Brokers + data-cascade reliability audit (report-only)

## Context & Objective

Owner asked for a read-only integration audit of Alpaca, Tradier, Robinhood MCP, market-data providers, FilingAPI/ROIC/SEC cascades, schema drift, retries, rate limits, reconciliation, symbol normalization, price precision, stale/fallback honesty, idempotency, health lanes, and user-visible correctness.  Goal: a dated evidence report the next agent can execute from, without stale claims about FilingAPI Plus or already-merged 422/socket fixes.

## Changes Made

Docs only.  No broker mutations.  No runtime or test changes.

- Wrote `docs/audits/2026-08-17-brokers-data-cascade.md` from HEAD `4980322b` plus the open-PR ledger (#2792 FilingAPI soft-skip, #2788 re-retire, #2798 leftover 401 mute, #2800 VIX re-probe / Pinecone remainder).
- Prepended this snapshot on `STATUS.md`, `PLAN.md`, and `docs/EFFORT-LOG.md`.

Exact files:

- `docs/audits/2026-08-17-brokers-data-cascade.md` (new)
- `docs/rollouts/2026-08-17-brokers-data-cascade-audit.md` (this note)
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-4-market-data-scoring.md` (FilingAPI #2792 caveat + audit pointer)
- `docs/source-capability-matrix.md` (same)

## Decisions & Trade-offs

- Report-only PR.  Highest-severity code fixes (Alpaca `stop_market` wire type, Tradier plain-order cents, Marketstack/ROIC admit, fetch-time `asOf`) are listed as follow-ups, not implemented here.
- FilingAPI: describe **both** merged retirement (#2787 on `main`) and owner-reversal soft-skip (#2792, CONFLICTING).  Do not pick.  Do not revive Plus checkout.
- Did not fetch a production ops snapshot.  This is a static integration audit; the ops script is for live strategy/scheduler incidents.
- Did not run the full verify gate.  No TypeScript or product code changed.

## Verification State

```text
git log -5 --oneline          # HEAD 4980322b includes #2799 / #2787
gh pr list --state open       # #2792 #2788 #2798 #2800 in ledger
gh pr view 2792               # OPEN CONFLICTING — owner reversal / soft-skip
```

Line-level confirmation of High/Medium findings is in the audit §7.  No `npm test` / `npx tsc` / `npm run build` (docs only).

## Next Steps & Blockers

1. Owner: pick FilingAPI (#2792 soft-skip vs keep `main` retirement / close #2788).  Then land #2798.  Then #2800.
2. Next code lane (not this PR): `toAlpacaOrderType` (`stop_market` → `stop`) and flip `test/alpaca-limit-stop-price-guard.test.ts`.
3. Then Tradier `roundCents` on plain orders; admit Marketstack + ROIC financials; stop fetch-time `asOf` on ROIC/Yahoo quote-only.

## Zero-Code Findings

See `docs/audits/2026-08-17-brokers-data-cascade.md`.  Short version: money-path architecture is sound; the live defects are an Alpaca outbound stop type mismatch (tests pin the wrong wire word), Tradier plain-order cent rounding, two quota call sites that skip `admitProviderRequests`, fetch-clock `asOf` on delayed ROIC/Yahoo quote-only rows, and an unresolved FilingAPI product decision.  Already closed on this HEAD: T sub-penny 422, UND_ERR_SOCKET single-blip halt, RH MCP extra args, ROIC 714-row crash loop, FilingAPI live HTTP on `main`.
