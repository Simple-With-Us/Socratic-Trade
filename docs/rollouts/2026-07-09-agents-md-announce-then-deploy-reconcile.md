# 2026-07-09 — Reconcile repo AGENTS.md/CLAUDE.md to the ANNOUNCE-THEN-DEPLOY ruling

## Summary

Updated the repo's canonical agent-instructions doc (`AGENTS.md`; `CLAUDE.md` is a symlink to it)
so its production-deploy language matches the owner's 2026-07-09 in-session ruling. Two spots:

1. **Handoff-protocol board semantics (~line 42):** was "'Completed' means merged to `main`
   (auto-deploys to beta/integration only); 'Deployed to production' is the separate **owner-run**
   release step (`~/apps/trading-live`)". Both halves were stale — previews are retired and
   auto-deploy is OFF (so merging to `main` deploys nowhere), and the release model is no longer
   "owner-run". Now: merged `main` auto-deploys NOWHERE, and "Deployed to production" is a separate
   **ANNOUNCE-THEN-DEPLOY** release.
2. **Production stanza (~line 138):** was "A production release is a **deliberate step**: trigger a
   Coolify deploy…". Now spells out the ANNOUNCE-THEN-DEPLOY protocol (claim → window → off-hours →
   deploy → own verify/boards) and points to `/Users/jay/apps/AG***-S**C.md` as the canonical detail.

## Why

The owner ruled (2026-07-09, in-session via another Monet session): production deploy authorization =
**ANNOUNCE-THEN-DEPLOY** — one deployer posts a #ag***-s**c claim (app + exact commit + contents +
"deploying in N min unless objection"), honors a ~10-min objection window, avoids market hours unless
it's a fix, and owns health-verify + boards. This **supersedes both** the 2026-07-06 unconditional
auto-deploy directive AND the older owner-ask-only reading. Earlier the same day, two Monet sessions
gave Codex opposite deploy-authorization answers because the two canonical docs disagreed; the ruling
lane fixed the cross-app `/Users/jay/apps/AG***-S**C.md` copy. This PR closes the **repo-doc half** so
`AGENTS.md`/`CLAUDE.md` (loaded into every agent's context) stops giving the contradictory
"owner-run/deliberate step" answer.

## Files

- `AGENTS.md` — two prod-deploy passages reconciled (doc-only; `CLAUDE.md` is a symlink, so both).
- `docs/EFFORT-LOG.md`, `STATUS.md` — handoff-protocol updates.

## Verification

- Doc-only change; no runtime surface. `land.sh` gate (tsc / test / build) run as the merge gate.
- Coordinated on #ag***-s**c with a claim line before editing (no objection; ruling lane had only
  updated AG***-S**C.md + memory, not the repo doc).

## Follow-ups

- None. If the ANNOUNCE-THEN-DEPLOY protocol is later refined, update `/Users/jay/apps/AG***-S**C.md`
  (canonical) first, then this repo stanza to match.
