# Account-relative risk post-merge review fixes

Date: 2026-07-13
Owner: CODEX
Branch: `codex/account-relative-risk-review-fixes`
Base: `origin/main@3e105e17`

## Summary

PR #1561 auto-merged before its Codex review posted. This follow-up addresses all three later P2
findings plus two independent adversarial-review refinements:

- The exact former `$500` product default now converts in legacy `settings.policy` as well as the
  account/profile/user policy stores during migration v26. Migration v27 is deliberately schema-only:
  once v26 is stamped, a fixed `$500` cap may be a new intentional user choice and is preserved.
- Socratic decision cases now persist and reload `greenTeamRationale` and `sizingSnapshot` through
  dedicated nullable columns. Lifecycle upserts (coach notes, outcomes, lessons) preserve both.
- “Objection overridden” now requires the final `PolicyDecision.socraticOverride.applied` truth.
  A request with no final resolution says “Rejected — override requested”; a known refusal says
  “Rejected — blocked.” Durable dissent evidence uses the final override resolution too.
- The early Red advisory path now emits `red_team_veto_override_requested`, not the false claim
  `red_team_veto_overridden`. Final application/refusal remains recorded only by the resolver;
  dashboard efficacy unions the new request event with historical rows without double counting.
- The configurable Guardrails Dollar/Percent selector now follows the persisted account whenever
  its field pair has no active draft, fixing stale mode after discard/save/account changes. Console
  draft, account-targeted API, and mobile-command tests prove each mode clears the other.

## Why

The original in-memory decision case carried exact Green prose and deterministic arithmetic, but
the DB upsert dropped them, so a refresh fell back to parsing the legacy concatenated rationale.
Also, `redTeamVerdict.overridden` is set when the model requests the advisory override path, before
hard gates and the final override resolver run; treating it as proof of application can display a
false successful override. The normal `getDb()` path copies global policy before versioned
migrations, but the exported migration function can be invoked directly. Migration v26 therefore
converts all four stores that may exist at that boundary. Re-running the conversion in v27 looked
idempotent but was semantically unsafe because a user can intentionally select fixed `$500` after
v26; the v26-start regression now protects that case.

## Files

- `src/lib/db.ts`
- `src/lib/db-socratic.ts`
- `src/lib/socratic-runtime.ts`
- `src/lib/strategy.ts`
- `src/lib/dashboard.ts`
- `src/lib/dashboard-feed.ts`
- `src/lib/dashboard-ui.ts`
- `src/lib/types.ts`
- `app/console/lib/red-team.ts`
- `app/console/components/policy-form.tsx`
- `app/console/page.tsx`
- `app/console/components/approval-card.tsx`
- `app/mobile/mobile-pwa-client.tsx`
- `test/console-red-team-labels.test.ts`
- `test/console-policy-diff.test.ts`
- `test/dashboard-feed.test.ts`
- `test/dashboard-fill-batching.test.ts`
- `test/mobile-api.test.ts`
- `test/policy-account-target.test.ts`
- `test/persistence-hardening.test.ts`
- `test/socratic-db.test.ts`
- `test/socratic-runtime-decision.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-07-13-account-relative-risk-and-decision-clarity.md`
- `docs/rollouts/2026-07-13-account-relative-risk-postmerge-review.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`

## Verification

Using Node `v24.18.0`:

```bash
npx vitest run test/persistence-hardening.test.ts test/socratic-db.test.ts \
  test/console-red-team-labels.test.ts test/socratic-runtime-decision.test.ts \
  test/dashboard-feed.test.ts test/dashboard-fill-batching.test.ts
# Combined load run: 64/65 passed; one unchanged 20-second dashboard timeout

npx vitest run test/dashboard-fill-batching.test.ts
# 1 file / 3 tests passed unchanged in 11.48 seconds

npx vitest run test/console-policy-diff.test.ts test/policy-account-target.test.ts \
  test/mobile-api.test.ts test/policy-normalization.test.ts test/policy-caps.test.ts \
  test/console-live-data-derive.test.ts
# 6 files / 54 tests passed

npx eslint src/lib/db.ts src/lib/db-socratic.ts src/lib/socratic-runtime.ts src/lib/types.ts \
  app/console/lib/red-team.ts app/console/page.tsx app/console/components/approval-card.tsx \
  app/mobile/mobile-pwa-client.tsx test/persistence-hardening.test.ts test/socratic-db.test.ts \
  test/console-red-team-labels.test.ts test/socratic-runtime-decision.test.ts
# 0 errors / 6 inherited warnings

npx tsc --noEmit
# passed

git diff --check
# passed
```

Full gate and hosted/deployment evidence will be appended before final handoff.

## Follow-ups

- Run the full Node 24 gate and land through a ready PR.
- Resolve the three original PR #1561 review threads only after the follow-up is merged.
- Verify the exact production SHA and DB/scheduler/Litestream health after auto-deploy.
- Keep PR #1548's broker-protective-stops file out of this follow-up.
- Host memory/OOM hardening remains a separately logged infrastructure effort; this branch makes no
  host or deploy-setting change.
