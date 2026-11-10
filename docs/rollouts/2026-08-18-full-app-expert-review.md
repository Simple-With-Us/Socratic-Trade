# 2026-08-18 — Full-App Expert-Panel Review (Desktop Web + Mobile Web + iOS)

## Context & Objective
Owner asked for a top-to-bottom review of the app by a diverse team of experts, covering the desktop and mobile websites and the iOS app, identifying everything that needs to be or could be fixed or improved.  Deliverable is a report, not product code (one hotfix was landed separately when the live pass found a fresh production regression).

## Changes Made
- `docs/reviews/2026-08-18-full-app-expert-review.md` — the review: executive summary (15 themes), 20 live-pass findings, 336 panel findings (40 P1 / 148 P2 / 148 P3) split needs-fixing vs could-be-improved, surface digests, prior-review cross-check (50 repeats, 15 still-open-not-recaught, 53 resolved), 50 verifier-added items, strengths, per-lane coverage, related Cursor audits, three-tranche sequencing.
- `docs/rollouts/2026-08-18-full-app-expert-review.md` (this note), `STATUS.md` stanza, `docs/EFFORT-LOG.md` rows (review row -> Completed; hotfix row -> Deployed).
- Separately landed: PR #2851 (`01f4e73e2`, live) — see `docs/rollouts/2026-08-18-connections-process-uptime-hotfix.md`.

## Method
- Workflow of 36 agents: 17 expert lanes (desktop-web UX, mobile-web UX, public site/growth, iOS HIG, iOS engineering, API contract web+iOS, web a11y, frontend perf, trading money path, performance accounting, backend reliability, LLM/agent architecture, security/auth, market-data integrity, UX copy, QA/test strategy, ops/observability/admin) -> one skeptic verifier per lane (CONFIRMED/PARTIAL/REFUTED/UNVERIFIABLE + corrected severity + missed items) -> prior-review cross-check -> synthesis.  The synthesis agent hit the session limit; the report was assembled from the raw structured results (journal) by MONET with a generator script, plus a hand-written executive layer.
- Live pass by hand: fresh `origin/main` worktree at `c55c2e642`, `next dev` on :3005 (Turbopack, then `--webpack`), desktop 1280x720 + phone 390x844, all 34 static routes curled; iOS built with `xcodebuild` for the simulator and walked on a dedicated `iPhone 17 Pro` device (`ST-Review-Monet`) in `-ASCScreenshots` fixture mode.
- Prod checked read-only via `/api/health` (release sha) only; no prod writes, no sign-in.

## Decisions & Trade-offs
- Verifier leniency (0 refutations / 336) is stated in the report rather than hidden; PARTIAL notes are the correction of record.
- Owner rulings (real trading, guardrails advisory, PWA out of scope, light default, copy rules, CT timestamps, sole user) were treated as constraints; items that are really owner decisions are labelled (LIVE-17, tsx-11, ios-08, sec-04, LIVE-05).
- Hotfix scope was kept surgical (guard + regression test); the root-cause split (`server-only` on `db.ts`, client-safe venue helper, dev bundler = prod) is the review's LIVE-01 / `frontend-performance:dweb-01`.
- The two iOS lanes both used `ios-NN` ids; verdicts were re-paired per lane from the agents' transcripts before assembling (uids are `lane:id`).

## Verification State
- Docs-only PR: no code gates required beyond CI `verify` (docs fast path).  Hotfix gates were run and recorded in its own rollout note.
- Report spot-checked for structure (11 sections, 40 P1 entries, tables render, ids traceable).

## Next Steps & Blockers
- Tranche 1 in the report §11 is the recommended next work: money-path (`tsx-01/02/08/04/09`, `api-02`), P&L (`perf-01/02/03/07/11`), LLM (`llm-01/02/04/06/10`), data freshness (`mdi-01/04/05/03`), `sec-01`, LIVE-01 root cause, `qa-03`, iOS (`ios-engineering:ios-01`, `ios-hig-ux:ios-01`, `api-01`, `api-03`, LIVE-15, `qa-01`), ops (`sre-02`, `sre-03`).
- Owner decisions listed in §11 Tranche 3.
- No blockers.
