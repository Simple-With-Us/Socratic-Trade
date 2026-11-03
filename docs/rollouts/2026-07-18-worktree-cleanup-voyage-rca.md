# 2026-07-18 — Merged-worktree cleanup sweep + Voyage `/api/health` RCA (CLAUDE)

## Summary

Docs-only session receipt for two operational efforts: (1) removal of 5 verified-clean,
merged worktree checkouts (with 3 deliberate keeps and a full verification table), and
(2) root-cause analysis of the "Voyage production health failure" — which turned out to be
OpenRouter credit exhaustion, not a Voyage credential problem. No product code changed.

## Why

Owner-directed cleanup of merged lanes (verify no unpushed commits / ownership before
removal) plus an owner-reported production health item ("Voyage production health failure;
investigate credentials/entitlement and restore /api/health").

## Worktree cleanup

Verification was delegated to a read-only Haiku sweep (per-path: `status --porcelain`,
PR merge state via `gh`, squash-merge ancestry via the PR's mergeCommit oid — branch HEADs
are never literal ancestors of `main` in a squash-merge repo — plus standing-lane and
`.janitor-keep` checks). Results:

**Removed (5)** — clean, PR merged, merge commit confirmed in `origin/main`; removal via
`git worktree remove` (+ prune). Branches and commits are retained — only checkouts died:

- `/private/tmp/socratic-pr1740-74qaIq` (detached; PR #1740)
- `/Users/jay/.codex/worktrees/socratic-account-relative-risk` (PR #1587)
- `/Users/jay/.codex/worktrees/socratic-sec-rag-program` (PR #1559)
- `/Users/jay/apps/socratic-st-primary-bridge-writer` (PR #1624)
- `/Users/jay/apps/socratic-usage-telemetry-replay` (PR #1563)

**Kept (3):**

- `/Users/jay/.codex/worktrees/socratic-pr1745.O3KoVh/worktree` — the checkout is clean but
  holds `codex/reconcile-pr1745` with **7 commits not on main and no PR** (the merged #1745
  head was a different branch). Unlanded work → CODEX disposition needed.
- `/Users/jay/.codex/worktrees/socratic-admin-console-shell` — 4 uncommitted files
  (PLAN/STATUS/effort-log/rollout note for the #1740 lane).
- `/Users/jay/apps/trading-ag-rag` — standing AG lane (protected pattern), despite PR #1669
  being merged.

**Already gone (4 paths):** `socratic-infra-panel-reliability` (#1751),
`socratic-pr1754.gVy2zF` (#1754), `ci-checkout-fast` (#1741), `ci-checkout-ref` (#1742).
**No worktree existed** for merged PRs #1441, #1451, #1728.

Anomaly flagged for awareness: `gh` reports PRs #1741/#1742 as MERGED but their recorded
mergeCommit oids are not ancestors of current `origin/main` (possibly superseded/rewritten
history); their checkouts were already gone, so nothing was actionable.

Worktree registrations: 103 → 98.

## Voyage `/api/health` RCA

- `https://socratictrade.com/api/health` returns **HTTP 200, `ok: true`** — the endpoint
  itself was already restored by the provider-aware criticality change (a dead Voyage lane
  no longer 503s the app while a non-Voyage embed provider is active; see
  `app/api/health/route.ts`).
- The remaining red flag is `dependencies.voyage.ok=false`. Production embeds run BGE-M3
  **via OpenRouter** (`ragEmbedProvider: "openrouter"`), and the Coolify app logs show every
  embed failing: `Embedding API failed (isOpenRouter=true): 402 "Insufficient credits"`.
  These failures are logged under the historical `voyage` service lane (known lane-naming
  caveat in `vector-db.ts`), which is what keeps the lane hard-failed.
- The OpenRouter (Socratic workspace) account is **exhausted: 25.00 total credits,
  25.31 used** (verified via the OpenRouter API).
- The actual Voyage credential is **valid** — a live `voyage-4-large` embed via the
  operator key succeeded during this session. This was never a Voyage credential or
  entitlement failure.
- Impact: all RAG ingestion/embedding (including the SEC 10→1,000 backfill program) is
  stalled on the 402s, and all LLM paths (strategy proposal/review, chat/RAG
  query-deconstruction, post-mortems, etc.) are also down — `resolveLlmEndpoint` routes
  every model through OpenRouter in production (`src/lib/llm-provider.ts:43`). Trading
  liveness (broker order placement via the lifecycle schedulers) is technically unaffected
  (`tradingLiveness.degraded: 0`), but the decision loop that drives autonomous trading is
  stalled without working LLMs.

**Owner action required (cannot be done by an agent):** top up OpenRouter credits at the
OpenRouter settings/credits page — or add a SiliconFlow key (SiliconFlow serves the same
`BAAI/bge-m3` model, keeping the vector space compatible; `vector-db.ts` already supports
it). **If going the SiliconFlow route:** adding `SILICONFLOW_API_KEY` alone is
insufficient — `resolveActiveRagProvider` (`src/lib/vector-db.ts:154-164`) checks for an
OpenRouter key before SiliconFlow, so the exhausted OpenRouter key would still route embeds
to OpenRouter. Also set `RAG_EMBED_PROVIDER=siliconflow` or remove/disable the OpenRouter
key. Do NOT flip `RAG_EMBED_PROVIDER` back to `voyage` — the corpus is in bge-m3 space.
**SiliconFlow is a RAG-EMBED-ONLY recovery:** it serves the `bge-m3` embed path, but
production LLM calls still route through OpenRouter (`resolveLlmEndpoint`,
`src/lib/llm-provider.ts`). So a SiliconFlow key restores RAG ingestion/embedding but leaves
the LLM decision loop (strategy proposal/review, chat, post-mortems) still failing — the LLM
paths require OpenRouter credits (or direct-provider keys). Topping up OpenRouter is the only
single action that recovers BOTH.

## Mid-session collision note (ag-reindex landing)

The stalled-looking `agent/ag-reindex-bge-m3` landing worktree turned out to be a LIVE
session mid-retry. Before detecting it, this session committed that worktree's 3 staged
docs files verbatim (`1dc1ceb9`) and merged post-#1762 `origin/main` (`36816e59`, add/add
rollout-note conflict resolved keeping the branch's superset side). The live session's
uncommitted test-timeout edits were untouched; a `land.sh` attempt refused on them and
changed nothing. Claim retracted + collision receipt posted on #ag***-s**c (sync-2); the
landing remains with its original session.

## Files

- `docs/rollouts/2026-07-18-worktree-cleanup-voyage-rca.md` (this note)
- `STATUS.md` (stanza)
- `docs/EFFORT-LOG.md` (row)
- Live board `/Users/jay/apps/TRADING-EFFORT-LOG.md` updated (Completed row added).
- Non-repo: 5 worktree checkouts removed as listed above.

## Verification

- `curl -sS https://socratictrade.com/api/health` → 200, `ok:true`, `voyage.ok:false`
- Coolify `application_logs` for `socratic-trade-prod` → repeated OpenRouter 402 embed errors
- OpenRouter credits API → `total_credits: 25`, `total_usage: 25.31`
- Live Voyage embed via operator key → success (vector returned)
- Per-worktree: `git status --porcelain` empty + `gh pr view <n>` MERGED + mergeCommit
  ancestor-of-`origin/main` before each removal; `git worktree list` count 103 → 98 after.

## Follow-ups

- Owner: OpenRouter credit top-up (or SiliconFlow key). Size it for the full backfill
  program (~$7.50 for the 1.2M-chunk corpus at $0.01/M, plus ongoing ingestion).
- CODEX: disposition `codex/reconcile-pr1745` (7 unlanded commits, no PR) and the dirty
  `socratic-admin-console-shell` docs files.
- Rename the RAG health lanes per-provider so OpenRouter/SiliconFlow failures stop being
  logged as `voyage` (already noted as a deliberate follow-up in `app/api/health/route.ts`).
- `dependencies.alpha-vantage.ok=false` is expected-inert (provider deregistered from the
  cascade by the ST-audit wave 1; noted here so nobody re-investigates it).

## Resolution (2026-07-18, MONET — verified during the CLAUDE cap-handoff land of this PR)

The owner-action follow-up is **DONE and production has recovered.** OpenRouter (Socratic
workspace) credits were topped up: the API now reports `total_credits: 75, total_usage:
25.31` (~$49.69 remaining, up from the exhausted 25/25.31 above). The embed lane recovered:
`https://socratictrade.com/api/health` now returns `dependencies.voyage.ok = true` (was
`false` during the outage), with app `ok:true`, DB ok, and the scheduler ticking. So all LLM
paths (which route through OpenRouter per #1703) and RAG ingestion/embedding are back online;
the autonomous decision loop is un-stalled. No code change was required — the fix was the
credit top-up. The per-provider health-lane rename and the CODEX worktree dispositions above
remain as open follow-ups.
