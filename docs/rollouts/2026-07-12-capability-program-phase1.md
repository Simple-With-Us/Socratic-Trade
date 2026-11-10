# 2026-07-12 - capability-program-phase1

## Summary

- Rendered Phase 1 of the owner-directed Capability & Platform Expansion program (four
  recon lanes, four design lanes, two adversarial feasibility verifications, one
  synthesized program) as a full-fidelity markdown plan document:
  `docs/reviews/2026-07-12-capability-program-plan.md`. Covers seven workstreams (iOS,
  web app, trading framework, short-selling+leverage, options groundwork, Kalshi,
  eToro), the program-level package train, sequencing waves, owner-decision list,
  dissent, per-lane design deep-dives (short/leverage, options, Kalshi, eToro) with
  their own current-state/design/packages/owner-decisions/risks, and the two
  feasibility-verification correction sets (Kalshi, eToro). No code from the program
  landed in this PR — this is documentation only.
- Truth-fixed the iOS status-doc overclaims this program's own dissent identified:
  `STATUS.md` ("2026-07-11 — Native iOS App Overhaul") and
  `docs/EFFORT-LOG.md` ("Native iOS App Overhaul... IN PROGRESS 2026-07-12") both
  claimed a `xcodegen`-initialized project, tabbed Dashboard/Proposals/Watchlist views,
  and a verified `xcodebuild`. None of that is true against the tree. Both rows
  corrected in place (never deleted) with a dated correction note and the original
  false text preserved/struck through per board convention.
- Added the `CAPABILITY+PLATFORM PROGRAM` row to `docs/EFFORT-LOG.md` (repo mirror),
  mirroring the live board's row (`/Users/jay/apps/TRADING-EFFORT-LOG.md:1624`) and
  updating it to reflect Phase 1 completion + a pointer to the plan doc.
- Added a short pointer entry to `PLAN.md` so the new program is discoverable from the
  existing roadmap doc without duplicating its content there.

## Why

- The owner directed a multi-agent Phase-1 workflow (recon → design → feasibility →
  synthesis) to scope seven capability/platform workstreams before any implementation
  starts. That workflow's raw JSON output
  (`.../tasks/w76an10kd.output`, `.result.program` / `.result.designs` /
  `.result.feasibility`) is not itself a durable repo artifact — this document renders
  it as a permanent, reviewable markdown plan so implementation packages (Wave 1
  onward) have a stable spec to build against without re-deriving it from a transient
  task-output file.
- Separately, this program's own recon (lane `ios-state`) discovered that two
  already-merged status docs falsely claim a verified native iOS build. Per repo
  convention ("never label real data mock/fallback," and more broadly "don't ship false
  status"), those overclaims needed correcting before this plan doc — which itself
  states the true iOS baseline in its dissent section — could be internally
  consistent with the rest of the repo's docs.

## Files

- `docs/reviews/2026-07-12-capability-program-plan.md` (new) — the full Phase 1 plan.
- `STATUS.md` — new dated entry for this session + in-place correction of the
  2026-07-11 Native iOS App Overhaul entry.
- `docs/EFFORT-LOG.md` — in-place correction of the Native iOS App Overhaul "In
  Progress" row; new `CAPABILITY+PLATFORM PROGRAM` row.
- `PLAN.md` — new pointer entry (no content duplication).

## Verification

- Documentation-only change; no source files (`src/`, `app/`) touched. `git status`
  confirms the diff is limited to `PLAN.md`, `STATUS.md`, `docs/EFFORT-LOG.md`, and the
  new `docs/reviews/2026-07-12-capability-program-plan.md`.
- iOS overclaims were spot-checked against the tree before editing, per the lane's
  instructions, rather than trusted from the task description:
  - `ls ios/SocraticTrade/` → 6 files (5 `.swift` + `README.md`).
  - `find . -iname "*.xcodeproj" -o -iname "project.yml"` → no results anywhere in the
    worktree.
  - `git log --all --diff-filter=A --name-only -- '*.xcodeproj' 'project.yml'` → no
    results — neither file type was ever committed, at any point in history.
  - `find ios/SocraticTrade -name "*.swift" | xargs wc -l` → 465 lines total across 5
    files, matching the lane's brief exactly.
  - `git log --oneline -- ios/` → last functional commit to `ios/` was 2026-07-03
    (`5cb40739`/`43146742`, both pre-dating the "Native iOS App Overhaul" claim);
    confirms "unchanged since early July" framing.
- Did not run the full `npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run
  build` trio for this change: it touches only Markdown files, no `.ts`/`.tsx`/`.mjs`
  source, so those gates cannot be affected. The serialized Land phase (per this
  lane's instructions: commit locally, `readyToLand=true`, do not run `land.sh`
  directly) will still run the full verify gate before merge.

## Follow-ups

- **Execution has not started.** This PR is Phase 1 documentation only. Wave 0
  execution packages (D2 orphan-commit PR for `ag/theme-selector`; eToro PR0 owner
  probe; K2-pre Kalshi order-model design memo; Tradier live-token validation
  escalation) are unclaimed as of this note, except a separately-reported concurrent
  sub-lane (`claude/kalshi-data-fetcher`, K1 Kalshi event-data fetcher, reported
  ready-to-land on the live board but not yet visible on `main`).
- **Live-board / memory-file corrections deliberately deferred, not forgotten.** The
  branch-neutral live board (`/Users/jay/apps/TRADING-EFFORT-LOG.md:236`, `:1331`,
  `:1636`) carries the same false iOS claims as the two repo docs corrected here, and
  the owner's Claude memory index (`capability-trading-program.md`) mislabels PR #1389
  as a capability-program foundation PR (it was FMP quota metering). Both are outside
  this repo/branch, and the live board in particular has an active concurrent claim
  from AG's native-iOS-rebuild lane — editing it from this branch risked clobbering a
  concurrent write. Flagged here for the owner or the next session to correct
  directly.
- **Nine owner decisions gate Wave 1+.** The plan doc §2 (program-level) and each
  lane's own owner-decisions subsection (§6.1–6.4) list them in full — most
  consequential: leverage OFF-state semantics (§2 item 1), the eToro Day-0 probe
  (blocking, owner-only, §2 item 6), and the iOS native-rebuild confirmation (§2 item
  3). None have been made as of this note; Wave 1 (the `types.ts`-serialized
  foundation packages) should not start until at least the leverage OFF-state and iOS
  direction calls are made, since they shape SL-P0's field defaults and I1/I2's scope.
- **Kalshi K2-pre and the eToro schema-verification pass (ET1) are hard blockers** for
  their respective trading gateways (K2a, ET2/ET3) — both are called out explicitly in
  §7 (Feasibility Verification) as open design gaps, not settled specs. Do not let a
  future package skip straight to gateway code on either lane.
