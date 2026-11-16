# Handoff: CLAUDE → Antigravity — Monet-Handoff §7 Ports (coach-note archive + lesson writer)

**From:** CLAUDE (Fable 5), worktree `socratic-trade-agent-team-697845`, branch `claude/socratic-trade-agent-team-697845`  
**To:** Antigravity/Gemini (primary recipient)  
**Date:** 2026-07-19 (12:30 UTC, mid-session handoff)  
**Status:** Work claimed and in progress; workflow interrupted; passing to next agent.

---

## What This Work Is

Execute the two verified-real gaps from `docs/handoffs/2026-07-19-monet-session-closeout-handoff.md` §7 — a fresh schema port of two 2026-07-04 branches (`claude/w2-coaching-durable` + `claude/w2-reflection-decompose`) whose mechanical rebase was rejected because the base tables moved since that date. Scope: two complementary writer lanes to close retrievable-but-unwritten doc-type gaps and eliminate silent data loss.

**Effort board reservations (both boards):** Rows added at line ~46 of both `docs/EFFORT-LOG.md` and `/Users/jay/apps/TRADING-EFFORT-LOG.md`; claim is "IN PROGRESS."

**Slack coordination:** #ag***-s**c claim posted 2026-07-19 21:48:42 UTC (message ID preserved if you need context).

---

## Port 1: Coach-Note Archive + Vector Writer (coaching-durable)

**The gap:** `appendSocraticDecisionCoachNote` in [src/lib/db-socratic.ts:307](src/lib/db-socratic.ts:307) silently drops the oldest note past 20 via `slice(-20)`, destroying data with zero trace. Violates product philosophy (no silent data loss, receipts/advisory everywhere).

**The fix:**
1. **Append-only archive table** — new `socratic_coach_note_archive` (user_id, decision_id, connected_account_id, note, archived_at). Audit receipt emitted ONLY when archival actually occurs (not on every append).
2. **Coach-note vector writer** — `indexCoachNoteMemory` mirrors the existing `indexSocraticDecisionMemory` pattern. Each note becomes a standalone doc_type='coach-note' vector with metadata: `{symbol, source: "socratic-coach-note", timestamp, accession: "<decisionId>:<noteIndex>", doc_type: "coach-note", decision_id, thesis_tag?, regime?, connected_account_id?}`. DedupKeyPrefix='coach-note' ensures no overwrites of sibling notes or the parent decision doc.
3. **Retrieve path already exists** — EPISODIC_DOC_TYPES in [src/lib/experience-memory.ts:44](src/lib/experience-memory.ts:44) already lists `['socratic-decision','coach-note','lesson']`, so the moment coach-note vectors exist, they become cross-decision retrievable.

**Files touched (typical):** `src/lib/db.ts` (migration + CREATE TABLE), `src/lib/db-socratic.ts` (archival + receipt), `src/lib/socratic-memory.ts` (new indexCoachNoteMemory), `src/lib/account-deletion.ts` (coverage), `app/api/socratic/decisions/[id]/coach/route.ts` (await the now-async append), test files.

**Design reference:** Old branch's rollout: `git show origin/claude/w2-coaching-durable:docs/rollouts/2026-07-04-w2-coaching-durable.md` (use as inspiration only; don't copy — schema has moved).

---

## Port 2: Lesson Doc-Type Writer (reflection-decompose)

**The gap:** The 'lesson' doc-type is retrieved on every decision run ([src/lib/experience-memory.ts](src/lib/experience-memory.ts), line ~525) and consumed by strategy.ts decision prompts, but **has no writer anywhere in `src/`** — only read, never written.

**The fix:** Decide the lesson source(s) against the CURRENT tree, explicitly trading scope vs. coverage:

**Option A (original scope, heavyweight):** Decomposed (thesisTag × regime) stat-bucket lessons from closed lots. `writeDecomposedLessons` in post-mortem.ts groups closed lots by thesis+regime, writes one discrete lesson per bucket into `learned_context` (fact tier, advisory only) with stats (win-rate, avg return, avg MAE/MFE, capturePct) + embedding as doc_type='lesson' vectors (source='reflection-lesson', dedupKeyPrefix='lesson'). Includes: regime-agnostic fallback rows when a thesis has total sample but every regime bucket is thin. Reconcile-on-write: identical stats → no rewrite; changed stats → supersede in place.

**Option B (minimal scope, lightweight):** Attach lessons via existing `attachSocraticDecisionCoachPrimitives(promoteTo:'lesson')` — the coach-note promotion route. Owner explicitly promotes a note to a durable lesson. Simpler, durable, but requires owner action per lesson.

**Option C (hybrid):** Write outcome-engine LLM lessons (already being generated per-decision in outcome-engine.ts line ~713) to `learned_context` as doc_type='lesson' vectors. Deterministic (no classifier), advisory-only.

Choose the smallest set that honors the original intent (retrievable, durable lessons) without re-engineering the whole reflection/decomposition pipeline if it's already been substantially rewired on main since 2026-07-04. Recon scouts will find which pieces already landed.

**Files touched (typical, Option A):** `src/lib/post-mortem.ts` (new writeDecomposedLessons + buckets + doc-type vector writer), `src/lib/db-learning.ts` (new table rows + helpers), `src/lib/db.ts` (new columns on learned_context + migration), `src/lib/types.ts` (optional regime/thesis_tag/dominant_factor on LearnedContextRow), `src/lib/strategy.ts` (thread regime + thesis tags into the learnedContext call), test files.

**Design reference:** Old branch: `git show origin/claude/w2-reflection-decompose:docs/rollouts/2026-07-04-w2-reflection-decompose.md` (same caveat — table schema may have moved).

---

## Recon/Design Already Started (Cached Results Available)

A previous session initiated an ultracode workflow (`wf_f2e1ca12-b41`) with:
- **3 scouts (Sonnet):** coach-path audit, RAG-writer contract verification, lesson/reflection current state. Recon results are cached in the workflow journal at `/Users/jay/.claude/projects/-Users-jay-Code-Socratic-Trade--claude-worktrees-socratic-trade-agent-team-697845/a8b6a12c-af22-412a-bf5d-994d18b9500e/subagents/workflows/wf_f2e1ca12-b41/journal.jsonl`.
- **1 frontier designer:** Not yet run, but the script captures both scout results and will produce a detailed change-plan.
- **Remaining stages:** 2 sequential implementers, 3-lens adversarial review, fix agent, final gate.

**To resume:** Relaunch the workflow with the exact command at the end of the prior session summary (resumeFromRunId="wf_f2e1ca12-b41" and the cached script path). Completed agents' results return instantly; new agents run live.

Alternatively, **you can ignore the cached scouts and run fresh recon** if you prefer starting clean.

---

## Hard Constraints (Non-Negotiable)

- **Advisory-only:** Nothing new may feed deterministic sizing/policy math. Failure semantics: vector indexing / embedding / LLM failures must NEVER block the coach-note append, promotion, or reflection/outcome pass (best-effort, degrade with receipt). A run with this feature broken must never be worse than a run without it.
- **Multi-user + account scoping end-to-end:** Every vector metadata, retrieval filter, and deletion path must be user AND account-scoped. The repo has an IDOR history — cross-user leakage is P0.
- **Provenance/rights-aware:** Follow the source-before-doc-type classification from PRs #1586/#1697. Avoid the EarningsCalls P1 pattern (wrong source triggering false "no active rights generation").
- **Migration discipline:** Exact version numbering (check current max in `src/lib/db.ts`), guarded ALTERs for both fresh and existing on-disk DBs, every test pinning a version updated.
- **Dedup keys:** Idempotent re-writes, never overwrite sibling notes/lessons or parent decision docs.

---

## What to Check First

1. **Current state snapshot:** Run `git fetch origin && git status` in the worktree.
2. **Scoped recon:** Inspect the cached results in the workflow journal (or run fresh scouts).
3. **Scope decision:** Decide between Options A/B/C for lesson writing based on what's already on main.
4. **Migration version:** Check `src/lib/db.ts` migrate() for the current max version.
5. **Test patterns:** Verify temp-DB patterns in existing tests (e.g., `test/socratic-db.test.ts`).

---

## Handoff Mechanics

- **Branch:** Stay on `claude/socratic-trade-agent-team-697845` (already checked out).
- **Boards:** Keep both effort-log rows IN PROGRESS and update status as work advances. Do not commit board/STATUS/PLAN/docs/rollouts/ changes — those are orchestrator's job; the landing script handles them.
- **Landing:** When code is complete and verified: `bash scripts/land.sh` (it auto-deploys on merge to main per 2026-07-10 rule).
- **Slack:** Post a one-line status to #ag***-s**c when you start and finish (or if you hit blockers).

---

## Follow-Ups (Not This Session)

From the original Monet handoff §7:

- **`claude/w2-coaching-durable` and `claude/w2-reflection-decompose` old branches:** Mark as superseded once this port lands.
- **Owner decisions still pending (§6 of monet-handoff):** autoResumeOnBoot, FMP_PRICE_TARGETS_ENABLED flag, QUIVER_API_KEY, SENTRY_DSN/SENTRY_CRONS_ENABLED, EarningsCalls RapidAPI subscription, API-Usage-Monitor scaffold.
- **Wave-3 candidates (§8):** NAV_V2 resume, admin theme unification, cross-repo FMP quota split, Pinecone memory hygiene, structured headlines with source/age.

---

## References

- **Monet closeout:** `docs/handoffs/2026-07-19-monet-session-closeout-handoff.md` (full context and verdicts on both branches).
- **Old branch designs (for inspiration):**
  - `git show origin/claude/w2-coaching-durable:docs/rollouts/2026-07-04-w2-coaching-durable.md`
  - `git show origin/claude/w2-reflection-decompose:docs/rollouts/2026-07-04-w2-reflection-decompose.md`
- **Fleet coordination:** `/Users/jay/apps/AG***-S**C.md` (canonical protocol).
- **Product philosophy:** `AGENTS.md` § "Product philosophy — real trading, owner's risk" (binding constraints on guardrails, no fake modes, no paternalism).

---

## Success Criteria

- Lint: 0 errors.
- TypeScript: clean.
- Test: full suite green (focused vitest files for both ports during development, full suite at gate).
- Code review: 3-lens adversarial verify (schema-correctness, money-path/failure-semantics, RAG-provenance/user-isolation).
- Deploy: auto-merge on `scripts/land.sh`, verified live on socratictrade.com/api/health.
