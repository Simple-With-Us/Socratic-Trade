# 2026-07-05 — GitHub Actions cost mitigation (MONET)

## Summary
Cut GitHub Actions minute consumption (~$0→$13/day spike) without weakening the
required `verify` / `smoke` / `gitleaks` merge gate. Four workflow edits:

- **`sentry-ci-report.yml`** — added a job-level `if:` so the reporter job only runs on
  a **failure** conclusion or a **schedule** event. It previously spun up a full runner +
  checkout for every one of ~95 workflow-completions/day, but its script is a no-op on the
  common case (successful, non-scheduled run). Those no-op cases now skip at **zero runner
  minutes**; failure alerts and cron missed-check-in detection are unchanged.
- **`ci.yml`** — dropped the `push: agent/**` trigger. Agent branches (e.g. Antigravity's
  `agent/antigravity/*`, `agent/claude`) that land always have a PR, so `pull_request`
  already runs `verify`; the `push` run was a duplicate (different ref → concurrency never
  deduped it). `push: main` + `merge_group` still cover merges/queue. (ci.yml already had
  the docs-only fast path, npm cache, and Next build cache.)
- **`e2e.yml`** (Playwright Smoke) — the biggest per-run cost. Added the **docs-only fast
  path** (a `classify` job mirroring ci.yml's, so the required `smoke` check reports success
  immediately on doc-only PRs instead of downloading a browser + building + running e2e).
  Also added **Playwright browser caching** (`~/.cache/ms-playwright` keyed on the lockfile)
  and dropped the duplicate `push: agent/**`.
- **`security.yml`** — dropped the duplicate `push: agent/**`. **Deliberately NOT** given a
  docs-only fast path: gitleaks must scan every diff (a secret in a `.md`/`docs` file is
  still a leak).

## Why (diagnosis)
~500+ workflow runs/day across the 4 repos on `ubuntu-latest` (no macOS 10× multiplier;
deploy is self-hosted/free). At ~2.5–3 min/run × Linux $0.008/min ≈ $10–13/day. The free
monthly allotment burns off in the first hour of fleet activity, then it's all overage. Two
amplifiers dominated: the Sentry report firing on all 7 watched workflows' completions
(95/day), and CI/Smoke/Security double-running on `push` + `pull_request` for agent branches.

## Not done (intentional)
- **Codex Autofix gating** — it fires on every review/comment (~20/day). Gating it to an
  explicit `@codex`/label trigger is Codex's own tooling call (would reduce its
  responsiveness), so left to the Codex lane.

## Files
- `.github/workflows/{ci,e2e,security,sentry-ci-report}.yml`

## Verification
- `ruby -ryaml YAML.load_file` — all 4 parse clean.
- The PR itself (workflow files = non-docs) triggers the full `verify` + `smoke` gate, so the
  non-docs path is exercised live; the docs-only path is the proven ci.yml pattern verbatim.
- The `sentry-ci-report.yml` change activates only after merge to `main` (`workflow_run`
  always uses the default-branch workflow file).

## Follow-ups
- Congress.Trade / api-usage-monitor / congress-trading-shared have their own CI and share
  the same amplifier patterns — the same treatments apply there if the bill stays high.
- Exact $ attribution needs `gh auth refresh -h github.com -s user` (billing API) or the
  Settings → Billing → Actions usage page.
