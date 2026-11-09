# 2026-07-23 — Unstick open PRs + effort-board hygiene (CURSOR)

## Summary

Cleared the stuck open-PR queue left after the Grok forgotten-PR audit: merged current
`origin/main` into all five remaining open PRs, resolved the two real content conflicts,
re-armed squash auto-merge, and corrected effort-board rows that still said In Progress after
their PRs had already merged.

## Why

Owner asked to resolve as many in-progress effort-log items and GitHub issues as possible.
Issues API returned 403 for this cloud token (cannot list/close Issues). The actionable path
was the five open PRs (all CONFLICTING/DIRTY or CI-failed on dirty self-hosted worktrees) plus
board hygiene for work already on `main`.

## Files

### Pushed on existing PR branches (not this PR)

| PR | Branch | Change |
|----|--------|--------|
| #1901 | `codex/retired-provider-usage-cleanup` | Clean merge of `origin/main` |
| #1902 | `codex/trade-approval-redteam-uptime-20260722` | Merge + resolve `src/lib/llm-provider.ts` (keep main OpenRouter-first + native routing; export `normalizeOpenRouterModelId`) |
| #1792 | `claude/advisory-cleanup-batch` | Merge + resolve `src/lib/vector-db.ts` (rag-embed health lane + stage telemetry); fix `test/connection-health-routing.test.ts` fixtures |
| #1819 | `claude/earningscalls-burst-smart-daily` | Clean merge of `origin/main` |
| #1842 | `agent/rapidapi-part2` | Clean merge of `origin/main` |

### This docs PR (`cursor/resolve-open-efforts-1c6c`)

- `docs/EFFORT-LOG.md` — claim unstick; correct completed rows in place
- `STATUS.md` — current snapshot
- `PLAN.md` — unstick note
- `docs/rollouts/2026-07-23-unstick-open-prs.md` — this note

## Verification

Focused Vitest (Node from cloud workspace):

- #1902: `test/model-rotation.test.ts` `test/openrouter-model-availability.test.ts` `test/console-api-html-error.test.ts` → 3 files / 27 tests
- #1792: `test/connection-health-routing.test.ts` `test/vector-db-lease-fencing.test.ts` `test/rag-universe-manifest.test.ts` → 3 files / 36 tests
- #1901: usage-monitor policy/push/replay → 3 files / 58 tests
- #1819: earningscalls + admin-operation-guard → 2 files / 56 tests
- #1842: document-summarizer + rapidapi-providers → 2 files / 38 tests

`git merge-tree --write-tree origin/main <pr-head>` → CLEAN for all five after push.

Auto-merge: `gh pr merge <n> --squash --auto` armed on all five; checks re-queued.

## Follow-ups

- Hosted `verify` / `gitleaks` / `check-pin` must go green for auto-merge to land (prior failures were self-hosted dirty workspace / missing `package.json`, not product regressions).
- After merge: exact Coolify SHA verify for each landed change.
- RAG feature enablement remains Planned (`docs/FEATURE-ENABLEMENT-BACKLOG.md`) — do not flip flags without re-embed proof.
- GitHub Issues: needs a token with Issues read/write; this session could not access them.
- Stale In Progress rows older than 2026-07-20 still need a later board pass (check-pin restore, smoke trim, which-key UI, etc.) once their PR status is confirmed.

## Follow-up during CI (same session)

- `#1819` hosted verify failed once: `persistence-hardening` expected a frozen settings key set
  after migrations through v57, but v57 seeds `earningscalls_burst_pending`. Fixed on the PR
  branch (`30f5c793`) to assert purge of the legacy cooldown key without freezing the key set.
- `#1842`/`#1901`/`#1902`/`#1792` still waiting on hosted verify queue at time of writing.

## Round 2 (2026-07-24, branch `cursor/resolve-open-efforts-2-1c6c`)

### Summary

- **#1901 MERGED** (retired broker Usage Monitor emissions).
- **#1980 MERGED** (prior docs/board hygiene).
- **#1981 MERGED** (model slug / `~latest` OpenRouter mappings) — forced a re-merge of #1902.
- Re-merged `origin/main` into the four remaining open PR heads after peer force-pushes rewritten tips.
- **#1902:** conflict in `src/lib/llm-provider.ts` — keep exported `normalizeOpenRouterModelId` but
  fill it with main's `~latest` alias table; focused Vitest `llm-provider` + `model-rotation` 24/24.
- **#1792:** remote tip dropped `if (embedding == null)` opener around rag-embed; restored HEAD guard
  (ESLint 0 errors on `vector-db.ts`).
- **#1819:** typed `SELECT key FROM settings` scan as `Array<{ key: string }>` for `tsc`; removed
  accidental `node_modules` symlink from the fix commit.
- **#1842:** clean main merge re-pushed.
- Board: corrected completed rows for #1847, #1828, #1839, #1981, check-pin-on-every-PR, which-key
  visibility, retired-provider cleanup, and collapsed #1892 duplicate detail bullets.
- Issues API still 403 for this cloud token.

### Verification (round 2)

- #1902 focused: `npx vitest run test/llm-provider.test.ts test/model-rotation.test.ts` → 2/24 green.
- #1792: `npx eslint src/lib/vector-db.ts` → 0 errors.
- Auto-merge squash re-armed on #1902/#1792/#1819/#1842; checks re-queued.
