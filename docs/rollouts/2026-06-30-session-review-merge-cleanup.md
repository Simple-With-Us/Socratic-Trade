# 2026-06-30 — Full app review, PR review-fixes, worktree cleanup (Claude session)

## Summary

A single session that (1) produced a comprehensive multi-expert improvement audit,
(2) landed/advanced the open PRs by fixing their blocking review feedback, and
(3) pruned the accumulated merged worktrees/branches.

## What changed

- **Audit deliverable:** `docs/reviews/2026-06-30-improvement-audit.md` — 11 specialist
  reviewers (models matched per task) across performance, learning, RAG/embedding, LLM
  use/prompting, UX/IA, aesthetics, data-source breadth, Congress.Trade integration, API
  Usage Monitor integration, and architecture/security; synthesized + adversarially critiqued.
- **PR #277** (Robinhood reconnect loopback) — merged; auto-deployed to production (Deploy
  run success).
- **PR #278** (strategy timeout/order-sizing guardrails) — fixed all Codex P2 review items
  over two rounds: routed the Red Team debate **and** pending-proposal revalidation through
  the `interactiveStrategyReasoningEffort` clamp (they were the paths that could still send
  `gpt-5.5`/high and re-trigger the timeout/run-lock); reserved the per-order/headroom cap for
  bracket-minimum raises; reserved the marketable-limit conversion buffer in sizing.
- **PR #279** (shared dep via GitHub Packages) — fixed a **P1 production token-leak**
  (`NODE_AUTH_TOKEN` persisting into `pm2 restart --update-env`) plus the same class of leak in
  the preview-sync workflow (`env -u` scoping); corrected the `GH_PAT`-preferred package-auth
  chain in ci/e2e/deploy; helper falls back to `GITHUB_TOKEN`; `packages: read` on preview-sync;
  ASCII-only script fix; STATUS.md/PLAN.md updated for the registry switch.
- **Worktree/branch cleanup (merged-only):** removed 38 stale worktrees and 128 merged local
  branches (detected via upstream `[gone]` OR `git cherry` patch-equivalence), while **keeping
  every dirty or unmerged worktree** and all protected lanes (main integration, the four agent
  previews, production `trading-live`, and the open-PR worktrees).
- **Review corrections:** re-baselined the audit after Codex review: historical IDOR is marked
  resolved instead of active P0, route-auth coverage is counted from the current tree (52/66
  route files import `resolveRequestUser`; 14 explicit exceptions), price-chart code-splitting
  is narrowed because `lightweight-charts` is already lazy-loaded, risk-breaker is noted as
  wired with residual live/durability follow-up, PLAN.md records the new priorities, and the
  stale missing Robinhood rollout-note reference is replaced by PR #282.

## Why

Owner asked for a full review of the app + its progress, cleanup/merge/deploy of other agents'
work, and a prioritized improvement list. The IDOR that gated prior multi-user work is verified
resolved, so the audit re-baselines priorities around the money-path (Red Team fail-open,
synthetic bid/ask anchoring limit prices) and the "built-but-unwired" gaps rather than auth.

## Verification

- PR #278: `npx tsc --noEmit`; targeted Vitest (sizing, llm-request, revalidation, policy,
  chat-draft, notifications) pass. Full `verify`+`smoke`+`gitleaks` CI gates the merge.
- PR #279: `bash -n` on both touched scripts; ASCII grep clean on touched files; YAML reviewed.
- This docs PR is documentation-only. Local review pass: `git diff --check`; `rg --files
  app/api -g 'route.ts'` + `rg -l "resolveRequestUser" app/api -g 'route.ts'` to recompute the
  route-auth baseline. Full `verify` CI (tsc → test → build) gates the merge.

## Follow-ups

- Implement the Robinhood small-dollar routing guard in `toMcpOrder` (dollar-routed/fractional
  orders must be `market`, not `limit` — Robinhood only fills fractional as market). Confirmed
  root cause of the $1 "Placed but never filled" behavior.
- The audit's top wiring gaps (Bear red-team fail-open, factor-weight loop closure, RAG retrieval
  eval, usage-telemetry push client) — see `docs/reviews/2026-06-30-improvement-audit.md`.
