# 2026-07-22 — Grok forgotten-PR audit (CURSOR review team)

## Summary

Owner asked Cursor to verify Grok PRs from forgotten/uncommitted past work make logical sense and do not undo later improvements. A multi-agent review team audited consolidated **PR #1952** (`grok/combined-seat-improvements`) plus the large reopen queue Grok armed during PR-queue drain.

**Verdict:** do **not** merge #1952. Close it and most stale reopens. Keep/fix a small set of fragment PRs and a few independent lanes.

## Why

Grok combined several unfinished lands into mega-PR #1952 (and earlier closed #1951). The congress "parity" re-land inside #1952 resurrects pre-migration modules and breaks current main hardenings. Separately, dozens of older Claude/Monet branches were re-opened despite already being on main or fighting newer main behavior.

## Findings (evidence)

### PR #1952 — DO NOT MERGE / CLOSED

| Lane | Verdict | Evidence |
|------|---------|----------|
| Congress webhook/SSE (#1949 re-land) | **UNDO + build break** | Imports deleted `@/lib/congress-webhook-auth`; uses `readBodyWithLimit` without `@/lib/bounded-body`; undoes shared-package signature/client/SSE work. Hosted `verify` fails with real tsc errors (run `29971565594`). |
| Risk/caps (#1903) | **FIX-FIRST** | `policy-caps.ts` already on main; PR clamps user dollar `maxDailyNotional` to NAV/spend; `$0` buyingPower falls back to NAV. |
| RAG (#1892) | **FIX-FIRST** | New flags mostly default-off (good); PR drops main OpenRouter classifier enrichment + `providerRequestId` metering in `vector-db.ts`. No Voyage prod reintro. |
| Approvals (#1902) | **OK if landed solo** | Busy retry only on `{status:"busy"}`; live-confirm preserved; rotation fail-closed on availability miss. |
| Usage (#1901) | **OK if landed solo** | Retires broker families from Usage Monitor feed; order placement paths untouched. |
| TwelveData (#1948) | **FIX-FIRST / solo** | Success `ok:true` health log path regresses vs main. |

### Queue hygiene table (actions taken)

| PR | Category | Action |
|----|----------|--------|
| #1952 | Combined mega-PR undoes Congress | **CLOSED** |
| #1892 #1901 #1902 #1903 | Fragments of combined land | **KEEP** (fix then land solo) |
| #1792 #1819 #1842 | Independent unique value | **KEEP** for separate review |
| #1904 #1905 #1906 #1909 #1914 | Stale reopen / undo risk | **CLOSED** |
| #1911 #1915 #1916 #1922–#1926 | Already on main | **CLOSED** |
| #1920 #1921 | Dangerous replay (db-split / auth already landed) | **CLOSED** |
| #1939 #1944 #1946 | CI/docs already superseded | **CLOSED** |

## Files

- This note: `docs/rollouts/2026-07-22-grok-pr-audit.md`
- Board: `/Users/jay/apps/TRADING-EFFORT-LOG.md` (+ mirror update on next commit)
- No product code changed in this audit pass (PR close comments only)

## Verification

- `gh pr checks 1952` — verify-hosted/verify **fail** (tsc), classify/gitleaks/check-pin pass
- Direct compare `origin/main` vs `origin/grok/combined-seat-improvements` for congress route + `policy-caps.ts`
- Worktree checkout of PR head confirmed broken congress imports
- Parallel review agents: risk, RAG, approvals/usage/data, queue classifier, adversarial merge judge

## Follow-ups

1. Land **#1901** (usage) when CI green — lowest risk.
2. Land **#1902** (Busy/rotation) when CI green.
3. Fix **#1903** daily-cap / zero-BP semantics, then land.
4. Rebase/fix **#1892** to restore main `vector-db` enrichment + requestId metering; keep RAG flags default-off.
5. Rebuild congress webhook parity **from current main** (shared package + bounded-body); do not revive `congress-webhook-auth`.
6. Tiny solo TwelveData health PR if still wanted.
7. Continue separate review of **#1792 / #1819 / #1842** (not Grok-combined).
