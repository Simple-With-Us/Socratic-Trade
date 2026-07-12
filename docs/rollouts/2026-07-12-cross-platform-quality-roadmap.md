# 2026-07-12 - Cross-platform quality roadmap

## Summary

- Ran three parallel read-only expert audits covering native iOS, desktop/mobile web/PWA, and the
  backend/trading framework.
- Reconciled those findings against current `origin/main@17b707ff`, the restored A01-A34 inventory,
  Claude's active iOS foundation and mobile-auth lanes, and Claude's existing Capability & Platform
  Expansion plan.
- Added `docs/reviews/2026-07-12-cross-platform-quality-roadmap.md` as a complementary quality,
  dependency, and release-gate roadmap. It covers product boundaries, invariants, six delivery
  waves, package seams, acceptance criteria, test matrices, runtime policy, deferrals, scorecard,
  and fleet ownership.
- Kept Node 24 as the required runtime and defined Node 26 as an allowed-failure canary until it
  reaches LTS and passes clean native-module, full-gate, and Coolify-equivalent boot proof.
- Escalated four native release blockers to `#agent-sync`: client/server auth-path mismatch and
  missing PKCE/state hardening; account-implicit mobile commands; non-preemptive STOP; and missing
  cross-client contract fixtures/release gates.

## Why

The capability program is broad and strong on broker/product expansion, but current implementation
truth exposed dependencies that must precede it: three remaining P0 money-path defects, an iOS auth
contract that the current client and server lanes do not share, account-implicit command execution,
STOP queued behind long work, an expensive shared dashboard read model, and insufficient iOS/web
release matrices. A separate addendum keeps those quality gates explicit without replacing or
duplicating the parent program.

## Decisions

- Finish Wave 0 trust/control blockers before enabling new execution capability.
- Treat `/console` as the canonical responsive web product, native iOS as the durable focused
  control client, and `/mobile` as a temporary compatibility surface until parity is proven.
- Converge TypeScript and Swift on server-owned versioned DTOs and checked-in JSON fixtures.
- Evolve the backend behind typed domain/application/port/adapter seams; do not rewrite it or add
  Postgres/Kafka/multi-instance complexity now.
- Keep asset execution semantics distinct: equity, option intent, and event-contract intent do not
  share one widened `OrderSide` vocabulary.
- Do not move production to Node 26 while it is Current rather than LTS.

## Files

- `docs/reviews/2026-07-12-cross-platform-quality-roadmap.md`
- `docs/rollouts/2026-07-12-cross-platform-quality-roadmap.md`
- `PLAN.md`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`

## Verification

- Read-only current-main/worktree inspection: git status/log, current iOS tree, active Claude iOS
  and mobile-auth worktrees, mobile routes/contracts, large web/backend modules, PWA and E2E setup.
- Three independent expert reports reconciled: iOS architecture/release, web UX/performance/a11y,
  and backend/trading correctness/operations.
- Compared against Claude's 1,930-line capability program plan before authoring; this document is
  explicitly an addendum and preserves its ownership/package train.
- `git diff --check` — passed for tracked changes; the new files also passed an explicit
  trailing-whitespace scan.
- Referenced local roadmap/framework/rollout paths — present. The Claude parent-program plan is
  explicitly active and unmerged in its owned worktree, so this branch does not duplicate it.
- Effort-row parity check — the seven-line roadmap status block is identical in the live board and
  repository mirror.
- Targeted Markdown structure review — 457-line roadmap headings, code fences, package IDs, local
  references, and primary standards links inspected.
- No product code changed; lint, TypeScript, unit tests, and build are not claimed by this planning
  package.

## Follow-ups

1. Active owners reconcile the auth endpoint name and implement PKCE/state/exact callback/revocation.
2. Claim and land the Wave 0 P0 packages in source-disjoint PRs before new money-path flags are
   enabled.
3. Add the Node 26 allowed-failure CI canary separately; do not alter `.nvmrc` or production yet.
4. Convert roadmap packages into effort-board claims only when an owner begins implementation; keep
   Claude's active parent-program rows authoritative meanwhile.
5. Update scorecard targets from measured baselines rather than weakening them silently.

## Blockers

- No blocker to the planning deliverable.
- Native TestFlight work remains blocked by the auth contract mismatch and missing app-level build,
  UI-test, signing, privacy-manifest, and release gates.
- New money-path capability enablement remains blocked by A21, A27, and A28.
