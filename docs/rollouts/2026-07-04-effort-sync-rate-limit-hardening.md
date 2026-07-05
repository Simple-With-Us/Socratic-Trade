# 2026-07-04 — Effort-issues sync: GitHub secondary-rate-limit hardening

## Summary

`scripts/sync-effort-issues.py` hard-failed (RuntimeError at `create_issue`, exit 1)
when its first bulk run created ~100 issues and GitHub returned 403 "You have exceeded
a secondary rate limit ... temporarily blocked from content creation" (observed
2026-07-05 UTC). Hardened the script:

- **Creation throttle** — `time.sleep(2.5)` (`CREATE_THROTTLE_SECONDS`) after every
  successful (non-dry-run) issue creation, so bulk runs pace themselves under the
  content-creation limit instead of tripping it.
- **Budgeted retry** — all API calls now go through `GitHubClient._request()`, which
  detects rate-limit responses (`403`/`429` with a "rate limit"/"abuse"/"temporarily
  blocked" message or a `Retry-After` header) and retries: sleep `Retry-After` when the
  server sent one, else exponential backoff (`15s * 2^(attempt-1)`, capped at 120s).
  Every retry sleep draws from a single bounded per-run budget
  (`RATE_LIMIT_RETRY_BUDGET_SECONDS = 300`).
- **Partial sync exits 0** — when the next wait would exceed the remaining budget,
  the run stops early and prints an explicit `PARTIAL SYNC — ... resume on next run`
  summary (with the per-run created/updated/... stats) and exits **0** instead of 1.
  The orphan-issue note is suppressed on a partial run (unprocessed rows would look
  like orphans). Non-rate-limit API failures still raise and exit 1 as before.

## Why

The sync is idempotent and board-driven — a rerun (daily cron `12 6 * * *` or the next
push to the board) resumes exactly where a rate-limited run stopped. A red workflow run
for an expected partial pass is therefore pure noise, while a genuinely broken sync
(bad token, API errors) should still fail loudly. Splitting those two outcomes is the
point of this change.

## Files

- `scripts/sync-effort-issues.py` — all changes (docstring "Rate limiting" section,
  constants, `http_request` now returns headers, `RateLimitBudgetExhausted`,
  `_rate_limited`/`_retry_after_seconds`, `GitHubClient._request`, creation throttle,
  `reconcile`/`_reconcile_items` split with partial-stats plumbing, `main` partial-exit
  paths).
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note — protocol docs.

No workflow change needed: `effort-issues-sync.yml` has no `timeout-minutes` (default
360 min), and worst case is ~4 min of throttle + ≤5 min of retry budget.

## Fleet propagation

Per fleet protocol the script is copied **verbatim** to `congress-trading-shared`,
`api-usage-monitor`, and `Congress.Trade` (it is repo-agnostic via
`GITHUB_REPOSITORY`). After this lands on `main`, the identical file goes to those three
repos via their own PRs, each with its own `docs/EFFORT-LOG.md` update.

## Verification

- `python3 -m py_compile scripts/sync-effort-issues.py` — clean.
- Offline harness (scratchpad, monkeypatched `http_request` + `time.sleep`, no network):
  15/15 checks — Retry-After parsing (case-insensitive, malformed→backoff), rate-limit
  detection (secondary-limit message, 429+Retry-After, plain 403 NOT matched, 404 never),
  retry loop success after Retry-After-then-backoff with exact budget accounting,
  `RateLimitBudgetExhausted` on insufficient budget, and two end-to-end `main()` runs
  (exhaustion during label setup and mid-reconcile) both returning 0 with a
  `PARTIAL SYNC` summary and no misleading orphan note.
- Live read-only run: `GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=... python3
  scripts/sync-effort-issues.py --dry-run` — parsed the real board, would
  create=101/update=305, exit 0.
- `npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run build` run by
  `scripts/land.sh` at landing (Python change; the JS gate is unaffected but required).

## Follow-ups

- Propagate to the three sibling repos (tracked on the effort board).
- The dry-run showed 305 pending body updates on existing issues (link ref churn from
  `GITHUB_SHA`) — pre-existing behavior, not touched here; those PATCHes also flow
  through the budgeted retry path now.

## 2026-07-05 addendum — landed, validated live, Codex-review refinements

- Merged as **PR #694** (verify/smoke/gitleaks green, auto-merge). On merge, the
  push-triggered `Effort Issues Sync` run on `main` — the exact bulk scenario that
  previously hard-failed — completed green: `created=101 updated=305 unchanged=0`, exit 0,
  no partial needed (the 2.5s create throttle alone kept it under the limit).
- Propagated verbatim: congress-trading-shared **PR #27** (merged), api-usage-monitor
  **PR #38** (merged), Congress.Trade **PR #162**.
- Codex's automated review on #162 raised three P2s; two were real gaps and all three were
  folded back into the canonical file (and re-propagated):
  1. Budget exhaustion while paging the initial `GET /issues` listing escaped the partial
     handling and would still exit 1 — the listing now sits inside `reconcile`'s
     try/except.
  2. A server-sent `Retry-After` was capped at 120s, retrying earlier than GitHub asked
     and burning budget — the cap now applies only to our own exponential guess; an
     over-budget `Retry-After` goes partial immediately.
  3. Bulk PATCH runs (e.g. the 305 body updates above) had no pacing — added a 1s
     `UPDATE_THROTTLE_SECONDS` after each successful update (GitHub guidance: >=1s between
     mutations). Empirically the unthrottled 305-PATCH run succeeded, so this one is
     insurance rather than a proven failure.
- Harness extended to 19 checks (uncapped Retry-After honored; listing-limited run exits 0
  partial); all pass. Worst-case added runtime for a full-churn run: ~4 min creates +
  ~5 min updates + ≤5 min retry budget — well under the workflow's default timeout.
