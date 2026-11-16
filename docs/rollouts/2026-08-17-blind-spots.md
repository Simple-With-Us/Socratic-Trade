# 2026-08-17 — Blind-spots audit (report-only)

## Context & Objective

Owner asked for a red-team panel across product strategy, code quality, test architecture, DX, observability, documentation, legal/fintech, accessibility, i18n, vendor lock-in, cost, and domains conventional architecture/trading/RAG/security/UX reviews skip.  Goal: overlooked assumptions and second-order risks, checked against live issues/PRs so claims are not stale.

## Changes Made

Read-only audit.  No production code.

- Added `docs/audits/2026-08-17-blind-spots.md` (findings with evidence, severity, user/outcome impact, concrete improvements).
- Handoff updates: `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this note.

## Decisions & Trade-offs

- Did not implement fixes.  Report-only PR by request.
- Excluded in-flight work: #2795 a11y chips, #2794 iOS privacy manifest, #2800 Pinecone 15-WU remainder, #2798 FilingAPI mute, #2799 (already on `main`).
- Did not treat FilingAPI as a live dependency (retired #2787) or restate the Pinecone Starter 2M wall (#2799).
- Did not re-litigate trading/RAG/security/UX reviews in `docs/reviews/`.
- Two-space sentence rule applied in the audit prose.

## Verification State

```bash
# Report-only; no tsc/test/build required for markdown.
gh issue list --state open --limit 50
gh pr list --state open --limit 40
```

Live snapshot taken 2026-08-17 ~23:40Z.  Evidence citations verified against `4980322b` / this branch.

## Rematch (2026-08-18)

Merged `origin/main` (`cbea64a9`, #2809 purchases + #2802 cross-app coordination).  GitHub `mergeable=CONFLICTING` was the union-merge phantom on `STATUS.md` / `PLAN.md` / `docs/EFFORT-LOG.md` — local `merge-tree` was clean, no `<<<<<<<` markers, no intent clash (three report-only audits each prepended their own Current block).  Restored the blank line after this audit's STATUS/PLAN entries.

## Next Steps & Blockers

Owner picks from the audit §6 table.  Highest calendar risk: Pinecone trial snap 2026-08-30 + ROIC Individual expiry.  Highest legal gap: clickwrap + in-desk disclaimer (Coach is stricter than Green/Red).  Do not spawn ten fix PRs from this list without an owner cut.

## Zero-Code Findings

Full register: `docs/audits/2026-08-17-blind-spots.md`.
