# 2026-07-09 — MONET usage-cap pickup (CLAUDE, owner-directed)

## ROUND 2 addendum (same evening, ~21:45 CDT onward)

MONET's cap reset, it ran a productive second session (took the first post-migration prod
deploy `wgoq4vmt` verifying TwelveData+AV keys live, rebuilt bump-to-floor, Mistral capmap,
round-2 on #1272, opened #1278–#1281), then **re-capped**. Owner directed a second pickup.

Outcome — all nine open PRs armed/merging on CI:

- **MONET's four new PRs**: #1279 (Mistral capmap — 2 real fixed incl. chunk-array parsing at
  high reasoning, verified against Mistral docs; 1 resolved-with-note), #1280 (bump-to-floor —
  1 real fixed: oversized below-minimum EXITS now block instead of full-exit-bumping; money-path
  reviewed), #1281 (armed; its CONFLICTING state was the known GitHub phantom — merge-tree
  clean), #1278 (learning-review — adopted MONET's uncommitted trigger feature
  `learningReviewMinNewLessons`/`MaxWaitDays`, fixed all 7 threads, and the adversarial
  re-review caught a REAL blocker pre-push: the max-age sweep was unreachable for learned rows
  older than the 7-day pack window (empirically reproduced) — fixed by counting un-reviewed rows
  via `assertedAt > lastReviewedAt` with no window cutoff, learned-row regression test added).
- **Round-3 bot threads on the follow-ups**: #1266 (3 real fixed — spoofable `shepherd-reran`
  marker now author-checked, cancelled-run rerun endpoint selection; 2 resolved-with-note on the
  YAML-guard trust boundary, with the honest Environments-based fix flagged as follow-up),
  #1267 (1 real P1 fixed — unconditional ok:true health log neutered the new breaker; now one
  health row per batch), #1269 (3 real fixed incl. a P1 same-tick fire gate; 1 false positive).
- **#1272** un-dirtied (clean main merge, MONET's content intact); **MONET's aapl lane**
  (owner-ruled NO-CAP enrichment + RAG filings warm-up receipts + demand-first ingestion;
  supersedes #1272 content, ordering documented in the PR) committed (dirty follow-ons adopted,
  nothing discarded) and landed as **PR #1287** — full gate 3261/3261 after fixing one stale
  blanket test assertion (`strategy-prompt-safety` tone check vs the deliberately neutral
  warm-up receipt).
- **Recon**: the 2-3 day activity audit produced zero artifacts — still not-started, MONET's on
  return. The RAG receipts work rode #1287.

## Summary

MONET hit its usage cap ~17:05 CDT mid-merge-shepherding. The owner directed CLAUDE to pick up
everything MONET had in flight. All of it is now merged or armed:

**The six blocked PRs** (all were CI-green + auto-merge-armed, blocked solely on unresolved
codex-connector review threads):

| PR | Lane | Outcome |
|----|------|---------|
| #1229 | RH broker-stop hardening (money-path) | MERGED; round-2 race fix rides #1269 (armed) |
| #1228 | Extended-hours protective exits (money-path) | armed post round-2 + conflict resolution |
| #1222 | Twelve Data free-tier fit | MERGED; round-2 health-row fix rides #1267 (armed) |
| #1221 | Short stop-loss 8% default | MERGED; round-2 spec-copy fix rode #1265 (MERGED) |
| #1215 | merge-shepherd CI fix | MERGED; round-2 4-fix batch rides #1266 (armed) |
| #1193 | Retire preview files | MERGED |

**Un-landed local lanes recovered and landed:** vitest tmpdir-leak fix → PR #1268 (MERGED);
settings-UX fixes (incl. a real `policy-diff classify()` looser/tighter mislabel bug) →
PR #1270 (MERGED); enrichment-starvation fix → PR #1272 (armed).

**Verified already merged pre-cap (no action):** #1224 autonomous-actions timestamps, #1227
cmd-K badge, #1209 intro size-jump incl. the LoadingBrand follow-up, #1217 reviewer veto
value-add. The stale local branches were just never deleted after their squash-merges.

## Why / decisions made

- **Review threads were NOT rubber-stamped.** Every unresolved codex thread (26 in round 1)
  was triaged against the current branch head by one agent and then adversarially verified by an
  independent skeptic. 20 were REAL — including all 5 on #1229 and all 4 (3×P1) on #1228, both
  money-path — and were fixed with regression tests; 6 were resolved with a factual note.
  Round-2 bot re-reviews surfaced 12 more findings (7 + 5 on #1228); all verified real and fixed
  the same way. Money-path diffs were gated by an adversarial diff review before any push
  (the #1229 reviewer independently ran the full suite, 3209/3209).
- **Auto-merge race → follow-up PRs.** Original PRs merged the instant round-1 threads resolved,
  so round-2 fixes that missed the window landed via follow-up PRs (#1265/#1266/#1267/#1269)
  rather than faking resolution on merged PRs.
- **#1228 conflict resolution:** main took #1229's stop-machinery mid-flight; merged with main's
  #1229 semantics winning in the stop files and the branch's exit-routing feature winning in its
  own files; full gate green (310 files / 3246 tests).
- **No deploys.** The Hetzner box migration (separate CLAUDE session) held all deploys; nothing
  in this pickup was released to production. MONET's promised post-#1222 deploy (activates the
  TwelveData fix + 6 Alpha Vantage keys) should ride the next announce-then-deploy.
- **Deferred, not dropped:** the 2-3 day activity audit (needs prod-DB reads; migration was
  mid-flight — MONET's to resume); broker-min bump-to-floor (claimed pre-cap, zero commits —
  effectively unclaimed again); PR #1083 recommended closed as a duplicate of merged #1082
  (owner call — permission gate correctly blocked unprompted close+branch-delete).
- The un-landed `monet/rotation-board-flip` docs commit is moot (main's mirror already shows
  rotation ✅); the branch can be deleted whenever branches are next cleaned up.

## Files (this docs commit)

- `docs/EFFORT-LOG.md` — row flips/annotations for: vitest-leak (✅ #1268, dupe row collapsed),
  settings-UX (✅ #1270), enrichment (#1272 armed), autonomous-actions (✅ #1224 pre-cap),
  reviewer veto value-add (✅ #1217), RH-hardening (premature "merged" claim corrected +
  close-out), activity audit (deferral note), new pickup summary row in Completed.
- `STATUS.md` — pickup stanza.
- `docs/rollouts/2026-07-09-monet-usage-cap-pickup.md` — this note.

Code changes were made on the respective PR branches (see the PRs above), not in this worktree.

## Verification

- Per-PR: focused tests + `npx tsc --noEmit` on each fix commit; adversarial diff reviews on
  #1229/#1228; full land.sh gates on #1268/#1270/#1272 (each ran lint 0-err / tsc / full vitest /
  build; #1272 twice after a mid-land main advance); #1228's conflict-resolution merge ran the
  full four-step gate (lint 0-err / tsc / 310 files 3246 tests / build).
- This docs commit rides the standard land.sh gate.

## Follow-ups

- Babysit-to-merge: #1228, #1266, #1267, #1269, #1272 are armed; the merge-shepherd launchd job
  + `gh run rerun --failed` cover smoke flakes. Live-board rows flip on merge.
- Two accepted non-blocking residuals on #1229 noted by its reviewer (permanently-uncancelable
  terminal order can wedge a `pending_cancel` row → symbol's broker-stop placement blocked while
  synthetic still protects; contrived teardown-tick quantity-mismatch corner) — candidates for a
  small hardening pass.
- Owner decisions pending: close PR #1083 (dup of #1082)? Ship the Run-once `__rotate__`
  precheck fix (diagnosed in-session: route precheck doesn't resolve the sentinel; scheduled runs
  work, manual Run-once 412s with a misleading "No LLM key" title)?
- MONET on return: activity audit, broker-min bump-to-floor, handoff-queue items
  (reviewedByModel stamp, Mistral capability map, strategy.ts split).
