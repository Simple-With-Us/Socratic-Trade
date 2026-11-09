# 2026-06-26 — Durable Codex↔Claude autofix GitHub Action

## Summary
Adds `.github/workflows/codex-autofix.yml`: an event-driven GitHub Action that
runs the official `anthropics/claude-code-action@v1` to autonomously address
Codex (`chatgpt-codex-connector[bot]`) PR review feedback — server-side, with no
chat session required.

## Why
The Codex↔Claude review loop was being driven from an interactive Claude session
(PR-activity subscription + hourly cron). That works but is **session-bound**:
when the session/container is reclaimed the loop stops. This moves the loop into
GitHub Actions so it is durable and covers **all** PRs (including future ones)
automatically.

## Design (no "both review first" competition)
Distinct roles: **Codex = reviewer** (fires on every push), **Claude = fixer**
(fires ONLY when Codex posts feedback). The job's `if:` gates on
`*.user.login == 'chatgpt-codex-connector[bot]'` across `pull_request_review`,
`pull_request_review_comment`, and `issue_comment` (PR-only). Claude never posts
its own review; it addresses Codex, pushes, Codex re-reviews → clean ping-pong.

The whole policy is in the workflow `prompt` (auditable in-repo): triage
outdated vs new Codex items, fix clear bugs + simple cosmetics, ask the
maintainer on anything ambiguous/architectural, run the verify trio, commit with
a `[codex-autofix]` marker, push, keep STATUS/docs in sync, and enable
`--squash --auto` merge once functional. **Round cap = 10** (counts
`[codex-autofix]` commits on the branch); beyond that it comments and stops.

## Prerequisites (one-time, owner action)
1. **Secret `ANTHROPIC_API_KEY`** (Settings → Secrets and variables → Actions).
2. **A token whose pushes re-trigger CI + Codex** — the default `GITHUB_TOKEN`
   does NOT re-trigger workflows, so EITHER install the **Claude GitHub App**
   (github.com/apps/claude) OR add a **`GH_PAT`** secret (repo + workflow scope).
   The job prefers `GH_PAT`, falling back to `GITHUB_TOKEN`.

## Loop safety
`--max-turns 60`, `timeout-minutes: 30`, per-PR `concurrency` group, the 10-round
cap, and the bot-author `if:` gate (Claude's own pushes don't match Codex's
login, so they don't self-trigger the fixer).

## Files
- `.github/workflows/codex-autofix.yml` — new.

## Verification
- YAML authored against the `anthropics/claude-code-action@v1` interface
  (`anthropic_api_key` / `github_token` / `prompt` / `claude_args`). The action
  itself only runs once merged + the secret/token are in place — opened as a
  **draft PR** for owner review of the automation before it goes live.

## Follow-ups
- Mirror to Congress.Trade (`app/`-rooted; verify = `cd app && npm run typecheck
  && npm test`; deploy via wrangler).
- Once both land + secrets are set, retire the interim chat-session cron/watch.
