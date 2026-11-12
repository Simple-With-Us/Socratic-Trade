# 2026-08-06 — Full-product review + deploy-freeze repair (MONET)

## 1. Context & Objective
Owner request: review the app to identify all issues/improvements/polish for the website
formats and the iOS app; verify cross-app coordination is working optimally; file
findings to the effort log + GitHub issues; verify existing board rows/issues are
accurate and properly characterized. Read-mostly session in the MONET lane
(`~/apps/trading-claude`, branch `agent/claude`, synced to `origin/main` = `0e9c79b1`).

## 2. Changes Made
- **Ops repair (production, not code):** removed zombie Coolify helper container
  `onlrw5mgf4s2pw9he4udt2kg` (13.5h old, from failed deploy of #2543) on the Oracle box;
  redelivered the newest main-push webhook twice to create deployments
  `zs8qq7wizjjti1kfk0pa4ajx` (failed, 6m) and `hphdauml77lu3ebmyj3rj95r`
  (see §4 for final state). No app containers, DNS, or settings were touched; prod
  stayed healthy on `6b47a886` throughout.
- **Docs:** `docs/reviews/2026-08-06-claude-full-product-review.md` (full findings, incl.
  live prod session receipts), this rollout note, STATUS.md current-section +
  two stale-line corrections (litestream claim, FMP blocker framing),
  `docs/EFFORT-LOG.md` + live board row moves/corrections (see §Corrections).
- **GitHub:** issues filed under label `product-review-2026-08-06`; stale effort-board
  mirror issues closed/relabeled with receipts (list in §Corrections).
- Exact files touched in this repo: `STATUS.md`, `docs/EFFORT-LOG.md`,
  `docs/reviews/2026-08-06-claude-full-product-review.md`,
  `docs/rollouts/2026-08-06-claude-full-product-review.md`.

## 3. Decisions & Trade-offs
- Deploy-freeze repair used **webhook redelivery** (the documented 2026-08-02 recipe),
  not manual Coolify deploy triggers, keeping the merge==live contract intact.
- Two redelivery attempts maximum; beyond that the failure is escalated to the owner
  rather than burning build cycles (each failed build costs ~10–45 min of box CPU).
- Live review was **strictly read-only** (no approvals/rejections/runs/settings writes;
  no OAuth performed by the agent — owner signed in).
- The disclosure-embed "Attempted 310 / Indexed 0" loop was verified in code to be
  dedup-before-embed (no API spend) and therefore filed as feed-noise polish, NOT the
  suspected credits drain — the OpenRouter credits alert traces to legitimate 10-K
  backfill embedding + LLM spend instead.

## 4. Verification State
- No app code changed → lint/tsc/test/build not run (docs-only commit; `verify` CI will
  still run on the PR).
- Deploy pipeline: 5/5 failures documented with Coolify deployment uuids + log receipts;
  retry `hphdauml77lu3ebmyj3rj95r` passed the full build step (`#15 DONE 629.6s`,
  further than any failure today) — final status + `bash scripts/verify-deploy-sha.sh`
  result recorded in #ag***-s**c when it lands.
- Prod health at review time: `ok:true`, scheduler ticking, 3 active accounts,
  `congress.trade` dependency intermittently failing, `filingapi` STOPPED 6d,
  litestream paused (kill-switch), R2 panel receipts in the review doc §A2/A3.

## 5. Next Steps & Blockers
1. **Owner: litestream/backup decision** (resume writes vs new target) — prod DB
   unreplicated since Aug 4.
2. **Owner/fleet: box contention** — isolate CT scan-worker (cpuset/nice) from Coolify
   builds, or move OCR batches off-box; add a `verify-deploy-sha` freshness cron so a
   frozen pipeline pages within the hour.
3. Regen `package-lock.json` so shared v2.5.1 actually ships (any agent; 5-minute fix +
  gates).
4. Work the filed `product-review-2026-08-06` issues by priority (C1–C4 first).
5. Usage Monitor R2 prune (98.6% storage) + CT Class A pace (236%) — cross-app owners.

## 6. Zero-Code Findings
The bulk of this session is investigation; all findings, receipts, and the
accurate-vs-corrected board audit are in the review doc and the issue batch.
