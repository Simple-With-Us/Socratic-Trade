# 2026-07-09 — Vitest temp-SQLite leak cleanup (MONET)

## Summary

The test suite no longer leaks its temp SQLite databases. Every test file points
`DATABASE_URL` at a fresh `file:<tmpdir>/agentic-<name>-<uuid>.db` (or a handful of
older name variants: `chat-*`, `trading-test-*`, `llm-provider-test-*`,
`golden-eval-test-*`) and nothing ever deleted the `.db`/`.db-wal`/`.db-shm` files —
178k files / ~130 GB had accumulated in `/var/folders/.../T` on the fleet Mac before a
manual cleanup on 2026-07-09. The fleet disk janitor now reaps them there, but CI
runners and any machine without the janitor kept accumulating.

Fix, zero test-file edits:

1. **`vitest.config.ts`** computes a per-run temp root
   `<realTmp>/agentic-vitest-<pid36>-<time36>` and sets `test.env.TMPDIR/TMP/TEMP` to
   it. Vitest spreads `config.env` over the inherited env when forking workers, so the
   whole test runtime — `os.tmpdir()` calls and the direct `process.env.TMPDIR ?? "/tmp"`
   reads both — resolves temp paths inside that one directory. Also exports the path via
   `process.env.AGENTIC_VITEST_TMPDIR` as a same-process fallback handoff.
2. **`test/global-setup.ts`** (new, wired via `test.globalSetup`) creates the per-run
   dir, returns a teardown that `rm -rf`s it, and on startup sweeps `agentic-*` entries
   older than 6h out of the REAL temp dir (same age rule as the disk janitor — old
   enough that a concurrent or even hour-long parallel run is never touched). Crashed or
   SIGKILLed runs leak only their single per-run dir, which the next run's sweep reaps.

## Why

Owner-reported: the leak was the hidden disk elephant on the fleet Mac (see the
disk-janitor memory/effort entries). The suite should clean up after itself on any
machine — CI, fresh clones, other developers — not rely on a host-specific janitor.
The per-run-directory approach was chosen over per-test-file teardown edits because
~306 test files across at least five naming conventions construct these paths; one
choke point at the TMPDIR level covers all of them (and future tests) with no churn
and no risk of missing a pattern.

## Decisions

- **6h stale threshold, not 1h**: matches the disk janitor's `>6h` semantics exactly and
  keeps a huge safety margin for parallel runs on the shared box (a sibling agent's
  in-flight run is at most minutes old; even an hour-long run is safe).
- **Sweep only `agentic-*` names** in the real temp dir: janitor parity, no risk of
  touching non-suite files. Legacy loose `chat-*`/`trading-test-*` leftovers predating
  this change aren't swept — going forward those names land inside the per-run dir, so
  the class dies out; historical ones are a one-time manual/janitor cleanup.
- **TMP/TEMP set alongside TMPDIR**: `os.tmpdir()` reads TMPDIR on unix but TEMP/TMP on
  Windows; covering all three keeps the funnel airtight cross-platform.
- Teardown `rm` failure is swallowed (e.g. Windows file locks) — the next run's sweep
  reclaims it; cleanup must never fail the suite.

## Files

- `vitest.config.ts` — per-run temp root, `globalSetup` wiring, TMPDIR/TMP/TEMP env.
- `test/global-setup.ts` — new: mkdir + teardown rm + 6h stale sweep.
- `AGENTS.md` — conventions bullet documents the mechanism and the "stay on the
  `tmpdir()` pattern, never hardcode `/tmp`" rule.
- `STATUS.md`, `docs/EFFORT-LOG.md` (+ live board), this note — protocol.

## Verification

All run in this worktree (`distracted-albattani-dfc422`, fresh `npm ci`):

- Probe run (`test/account-scope.test.ts` + `test/chat-history.test.ts`, covering both
  the `tmpdir()` and the `process.env.TMPDIR ?? "/tmp"` patterns) with mid-run watching:
  DB files observed INSIDE the per-run `agentic-vitest-*` dir during the run; dir gone
  after teardown; **zero** new loose entries in the real temp dir.
- Stale-sweep probe: a 7h-old `agentic-*.db` file and a 7h-old `agentic-vitest-*` dir
  were reaped; a fresh `agentic-*.db` file survived.
- `npm run lint` — 0 errors (368 pre-existing grandfathered warnings).
- `npx tsc --noEmit` — clean.
- `npm test` — 306 files / 3171 tests passed; before/after diff of the real temp dir
  showed zero leaks from this run. (Five `agentic-broker-min-guard-*` /
  `agentic-rh-order-checks-*` file sets DID appear during the window — traced via
  `ps`/`lsof` to a concurrent sibling session's vitest in worktree `bold-lamport-20a8f9`
  running WITHOUT this fix; they'll stop once this lands and sibling worktrees sync.)
- `npm run build` — clean.

### Landing verification (2026-07-09, CLAUDE — owner-directed usage-cap pickup)

MONET authored and committed this change; CLAUDE landed it under the owner-directed
usage-cap pickup. Run in the same worktree after merging `origin/main` (clean merge,
no conflicts):

- `npm run lint` — 0 errors.
- `npx tsc --noEmit` — clean.
- `npm test` — 308 files / 3210 tests passed (post-merge count; includes the new
  `test/api-clients-congress.test.ts` / `test/protective-exit-routing.test.ts` etc.
  from main).
- `npm run build` — clean.
- Meta-irony check (this change redirects vitest tmp usage, so the landing run is
  itself a test of it): immediately after `npm test`, the real temp dir was checked
  for `agentic-vitest-*` — none present; the per-run dir was created and torn down as
  designed. No new loose `agentic-*` DB files from this run either.
- `docs/EFFORT-LOG.md` resolution note: the branch's copy of the board was a stale
  snapshot carrying old IN PROGRESS rows for other MONET lanes that `main` already
  shows as COMPLETED/DEPLOYED (alert triage, intro size-jump #1209, learning review
  #1116, mobile chrome fixes, etc.). To avoid resurrecting stale duplicates via the
  union merge driver, the landing commit takes `origin/main`'s board wholesale and
  annotates ONLY this lane's row — no other lane's row was deleted or altered.

## Follow-ups

- Sibling agent worktrees pick up the fix on their next `origin/main` sync; until then
  their runs still leak (janitor covers the fleet Mac).
- Optional future tightening: normalize the legacy `chat-*`/`trading-test-*`/
  `llm-provider-test-*` DB names onto the `agentic-*` prefix for janitor visibility —
  cosmetic now that they live inside the per-run dir.
