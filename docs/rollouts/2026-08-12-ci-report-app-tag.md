# 2026-08-12 — CI scripts: Sentry `app` tag + branchless fingerprint, effort-sync transport retry

## 1. Context & Objective

Two independent defects in this repo's CI-support Python scripts, both landed
together because they are one-file-each, python-only, and share a reviewer.

1. **Sentry CI reports were anonymous.**  `fleet-infra` is a *shared* Sentry
   project across the fleet, and this repo shares workflow names ("CI",
   "Security", "Effort Issues Sync") with Congress.Trade.  Congress.Trade's copy
   of the reporter tags every event `app:congress-trade`; ours carried no app
   identifier at all, so an ST failure titled "CI workflow failed: Security
   (branch main)" was indistinguishable from — and grouped with — the CT issue
   for a different repo's Security workflow.
2. **The effort-issues sync died on any transport failure.**  Today's scheduled
   run failed outright with `SSL: CERTIFICATE_VERIFY_FAILED: self-signed
   certificate` reaching `api.github.com`.  This is the same unretried-transport
   bug just fixed in Congress.Trade (PR #1800, branch
   `claude/effort-sync-transport-retry`); this change ports it.

## 2. Changes Made

### `scripts/sentry-ci-report.py`

- New module constant `APP = "socratic-trade"`, placed with the other module
  constants above `CRON_SCHEDULES`, mirroring Congress.Trade's copy.
- `APP` now appears in three places on the failure event: the message suffix
  (`... [socratic-trade]`), the `app` tag, and the fingerprint.
- **Fingerprint no longer includes branch:** `["ci-failure", APP,
  workflow_name]`, down from `["ci-failure", workflow_name, branch]`.  Branch
  remains a tag, so "which branch broke" is one tag click away in Sentry.
- Docstring rewritten to explain both the shared-project `app` requirement and
  the branchless-fingerprint rule, so the next agent does not "restore" either.

### `scripts/sync-effort-issues.py`

- `http_request` previously caught **only** `urllib.error.HTTPError`.  Anything
  below the HTTP layer — TLS handshake rejection, DNS blip, socket reset, a body
  cut short mid-read — propagated and killed the whole run.
- Added bounded exponential-backoff retry around the `urlopen` call, covering
  `http.client.IncompleteRead`, `http.client.HTTPException`,
  `urllib.error.URLError` (which is what wraps `SSLCertVerificationError`),
  `ConnectionError`, `TimeoutError`, and `json.JSONDecodeError`.
- New constants: `TRANSPORT_RETRY_METHODS`, `TRANSPORT_RETRY_ATTEMPTS` (4),
  `TRANSPORT_BACKOFF_BASE_SECONDS` (2.0), `TRANSPORT_BACKOFF_MAX_SECONDS` (15.0).
- New `import http.client`.
- New "Transport failures" section in the module docstring.

### Touched files

- `scripts/sentry-ci-report.py`
- `scripts/sync-effort-issues.py`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-12-ci-report-app-tag.md` (this file)
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (live board, untracked mirror)

## 3. Decisions & Trade-offs

- **Only idempotent methods are retried.**  `TRANSPORT_RETRY_METHODS` is
  `{GET, HEAD, PUT, PATCH, DELETE}`.  A `POST` that created an issue but whose
  response body was truncated has *already mutated the repo* — replaying it
  would file a duplicate issue, which is strictly worse than the failure being
  fixed.  POSTs surface the transport error and let the next scheduled run
  reconcile; creation is keyed off the board, so a re-run is self-healing.
- **The `HTTPError` except-clause stays ahead of `URLError`.**  `HTTPError`
  subclasses `URLError`; reordering them would swallow every real HTTP response
  into the transport-retry path and silently disable the existing secondary
  rate-limit backoff in `GitHubClient._request`.  A comment now says so at the
  clause.
- **Crons `monitor_slug` deliberately NOT namespaced with `APP`**, even though
  Congress.Trade's copy emits `ci-{APP}-{slug}`.  These slugs are *live* Sentry
  Crons monitors; renaming them would orphan the existing ones, which would then
  alert "missed check-in" forever while brand-new monitors relearn their
  cadence.  There is also nothing to fix: CT already emits `ci-congress-trade-*`,
  and no other fleet repo sends check-ins (Usage-Monitor has no copy of this
  script — verified).  A comment at the assignment records this so it is not
  "fixed" blindly later.
- **Branch demoted to a tag rather than dropped.**  The pre-existing
  `pageworthy_branch` gate already limits paging to `main` and
  `gh-readonly-queue/*`.  That gate alone was not sufficient: merge-queue refs
  are unique per attempt (`gh-readonly-queue/main/pr-1234-<sha>`), so keeping
  branch in the fingerprint still minted a throwaway issue per queued run — the
  same failure mode that produced FLEET-INFRA-2N/-2H off agent branches.
- **Existing Sentry issues will re-group.**  The fingerprint change means
  currently-open ST CI issues stop receiving new events; the next failure opens
  one fresh issue per (app, workflow).  This is the intended migration and needs
  no manual cleanup — old issues age out on their own.
- **The `ALERT_CONCLUSIONS` broadening present in Congress.Trade's copy was NOT
  ported.**  CT alerts on `failure` / `timed_out` / `startup_failure`; ST still
  alerts on `failure` only.  That is a separate behavioral change, out of scope
  for this fix, and worth its own decision.

## 4. Verification State

Both scripts are python-only and are not exercised by the TypeScript gates.  They
were verified directly, then the repo gates were run anyway per AGENTS.md.

```
python3 -m py_compile scripts/sentry-ci-report.py scripts/sync-effort-issues.py   # clean
```

A behavioral harness (scratchpad, not committed) drove both scripts end-to-end:
the reporter against a local stub HTTP server capturing the real Sentry
envelope, and `http_request` against a monkeypatched `urlopen`.  **15/15 checks
pass**, including:

- Envelope message ends `[socratic-trade]`; `tags.app == "socratic-trade"`.
- `fingerprint == ["ci-failure", "socratic-trade", "Security"]`, and contains no
  branch component, while `tags.branch` still carries the merge-queue ref.
- `GET` recovers after two `SSLCertVerificationError`s — today's exact failure —
  and after an `IncompleteRead`.
- `PATCH` retries; **`POST` raises on the first failure with exactly one
  underlying call** (no duplicate-issue replay).
- Retry is bounded at `TRANSPORT_RETRY_ATTEMPTS`, not infinite.
- A 403-with-`Retry-After` still returns through the `HTTPError` path and still
  trips `_rate_limited`, proving the rate-limit backoff is intact.

Repo gates (run under Node 24 — homebrew's default `node` is v26, whose
`better-sqlite3` ABI mismatch mass-fails the suite):

```
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Results are recorded in the PR body.

## 5. Next Steps & Blockers

No blockers.  Follow-ups, none urgent:

- Consider porting Congress.Trade's `ALERT_CONCLUSIONS` broadening
  (`timed_out` / `startup_failure`) to this repo — deliberately excluded above.
- If a future fleet repo starts sending Crons check-ins, revisit the
  un-namespaced `monitor_slug` decision at that point, with a planned monitor
  migration rather than a silent rename.

## 6. Zero-Code Findings

n/a — code was changed.
