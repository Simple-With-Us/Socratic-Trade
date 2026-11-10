# 2026-07-10 — Effort-log union-merge safety net (fleet-infra)

## Summary

Adds `scripts/effort-log-union-merge.py`: a row-level, invariant-checked merge tool
that reconciles the machine-local live effort board (`/Users/jay/apps/<APP>-EFFORT-LOG.md`)
against the repo-tracked mirror (`docs/EFFORT-LOG.md`) **without ever dropping a row that
exists only on the live board**.

## Why

A fleet coordination note (`codex-automerge-race-and-board-clobber` memory) reported: "A
merge-shepherd launchd job (every 30 min, MONET-built 2026-07-09, digest in tracking issue
#1214) union-merges `/Users/jay/apps/TRADING-EFFORT-LOG.md` with the repo mirror — and rows
that exist ONLY on the live board get deleted (observed: a pickup claim row added 17:35 was
gone by 18:22)."

**Investigation finding:** an exhaustive search of every candidate location — the
`com.jay.merge-shepherd` launchd plist, `~/.claude-merge-shepherd/{run.sh,merge-shepherd.sh}`
(the actual host-side driver), the in-repo `scripts/merge-shepherd.sh` (all three copies —
this repo, `trading-monet-rh-harden`, `trading-monet-llmusage` — are functionally identical
modulo unrelated round-3 review fixes), every `/Users/jay/apps/*.sh`, every worktree's
`scripts/` directory, `.zsh_history`/`.bash_history`, and the `FLEET-INFRA-EFFORT-LOG.md`
board itself — found **no code that touches `/Users/jay/apps/TRADING-EFFORT-LOG.md`
programmatically at all**. `merge-shepherd.sh` only calls the GitHub API (`gh pr
merge`/`update-branch`/`comment`); it never reads or writes the Mac filesystem outside its
own log directory. The only real "union-merge" in the codebase is `docs/EFFORT-LOG.md
merge=union` in `.gitattributes` — git's built-in union driver, which only ever operates on
that one git-tracked file during a `git merge`, and only ever *adds* lines (it cannot delete
a row).

What most plausibly explains the observed row loss: an agent doing a board-conflict
resolution manually took **origin/main's mirror wholesale** as the reconciled content (an
already-documented pattern — see `docs/rollouts/2026-07-09-vitest-tmpdb-cleanup.md`: "To
avoid resurrecting stale duplicates via the union merge driver, the landing commit takes
`origin/main`'s board wholesale") and, at some point, that wholesale-mirror content was also
used to overwrite the *live* board — which silently drops any row an agent had added to the
live board but not yet mirrored into a commit. That is a manual/ad hoc failure mode, not a
scheduled job, but the fix is the same either way: a mechanical tool that performs the
"take the mirror, but never drop a live-only row" operation safely, so nobody has to get the
manual version right under time pressure again.

## What was built

`scripts/effort-log-union-merge.py` (stdlib-only Python, no third-party deps, matching the
existing `scripts/sync-effort-issues.py` convention):

- Parses both files with the same section/bullet model as `sync-effort-issues.py`
  (`## `-heading sections classified into `deployed`/`completed`/`in-progress`/`planned` by
  keyword; a top-level `- `/`* ` bullet starts an item; indented/blank lines fold into it).
- Item identity = SHA1 of the normalized first line — identical scheme to
  `sync-effort-issues.py`'s `effort-key`, so the two tools never disagree about row identity.
- **Output = the mirror's content verbatim, plus every live-only item appended into the end
  of its matching bucket section** (a new "(recovered by union-merge safety net)" section is
  created if that bucket has no existing section in the mirror at all). Items whose key is
  already in the mirror always take the mirror's text — "only rows present in a mirror may
  be updated from the mirror," per the fix requirement.
- **Hard invariant, enforced before AND after every write**: every item key present on the
  input live board must be present in the computed (and then actually-written) output. A
  violation aborts with no write and a non-zero exit rather than risk a silent drop — this
  is a mechanical guarantee, not just an intended behavior.
- `--dry-run` (default) reports what would be recovered and writes nothing. `--apply`
  writes to `--out` (defaults to `--live`). The mirror path is **never written** — the
  tool's blast radius is exactly the file the historical bug corrupted.

This tool only ever needs to be invoked with Mac filesystem access (it takes explicit
`--live`/`--mirror` paths), so — like `sync-effort-issues.py` explains for the reverse
direction — it is not wired into GitHub Actions; it's meant to run host-side (e.g. from the
`~/.claude-merge-shepherd` driver, or ad hoc before a manual board reconciliation). Wiring
it into the always-on 30-minute launchd job is a follow-up, deliberately left out of this
change: that job lives outside this repo (`~/.claude-merge-shepherd/run.sh`,
`~/Library/LaunchAgents/com.jay.merge-shepherd.plist`) and touching the always-running
fleet-coordination cron is out of scope for a repo PR under a "no deploys" constraint.

## Verification

All testing was done against **copies in a scratch directory**; the real live board
(`/Users/jay/apps/TRADING-EFFORT-LOG.md`) and the mirror were only ever read, never written
(md5-verified unchanged before/after every test run below).

- `python3 -m py_compile scripts/effort-log-union-merge.py` — clean.
- `npx tsc --noEmit` (node@24) — clean (no TS files touched).
- **Real-data dry-run**: copied the live board (1724 lines, 177 items) and mirror (2293
  lines, 208 items) to scratch; dry-run correctly identified 13 live-only rows (real,
  not-yet-mirrored claims — e.g. the MONET learning-review/vitest-cleanup/mistral-rebench
  in-progress rows) that would be recovered, and wrote nothing (verified via checksum).
- **Sentinel add/recover test**: added a synthetic `SENTINEL-TEST-ROW-UNION-MERGE-DRYRUN`
  row to the scratch live-board copy only (not in the mirror copy); `--apply` against a
  scratch `--out` recovered it (now 14 live-only rows) into the correct "In Progress"
  section, with correct blank-line spacing before the next heading; the mirror copy's
  checksum was unchanged (never written).
- **Idempotency test**: merging the mirror against itself as "live" produces byte-identical
  output (0 rows recovered).
- **Subset test**: a live board that's a strict subset of the mirror's rows produces output
  byte-identical to the mirror (0 rows recovered).
- **New-bucket test**: a live-only row in a bucket that has no section at all in the mirror
  gets a new `## <Bucket> (recovered by union-merge safety net)` section appended at the end
  of the document, rather than being dropped.
- **Invariant self-check test**: sabotaged a copy of the script so `recover_missing_items`
  became a no-op passthrough (simulating a latent bug), reran it — the post-computation
  invariant check correctly detected the missing live-only key, printed a
  `INVARIANT VIOLATION` error, exited 2, and **wrote no output file** (confirmed via `ls`).

## Files

- `scripts/effort-log-union-merge.py` (new)
- `docs/rollouts/2026-07-10-effort-log-union-merge-safety.md` (this file)
- `docs/EFFORT-LOG.md`, `STATUS.md` — protocol-required updates

## Follow-ups

- Wire `scripts/effort-log-union-merge.py` into the host-side merge-shepherd driver
  (`~/.claude-merge-shepherd/run.sh`) so the live board is reconciled against the mirror
  automatically on the existing 30-minute cadence, once a human/owner-supervised session
  can touch that always-running Mac cron (outside this PR's scope).
- Consider also running it (dry-run first) any time an agent is about to do a manual
  "take the mirror wholesale" board-conflict resolution, instead of hand-copying content.
- The live board has some pre-existing formatting quirks independent of this fix (e.g. two
  bullet items concatenated onto one physical line with no bullet marker between them,
  around the "2-3 day activity audit" / duplicate `## Completed` and `## In Progress`
  section headings) — this tool faithfully preserves them rather than correcting them
  (out of scope; a markdown-lint pass on the board is a separate, optional effort).

## Landing-round review fix (same day, PR #1354)

`required_conversation_resolution` on `main`'s branch protection blocked the merge on three
unresolved codex-connector P2 comments on `scripts/effort-log-union-merge.py`. All three were
legitimate for a tool whose entire purpose is preventing exactly this class of data loss, so all
three were fixed rather than resolved-with-a-note:

1. **Non-atomic write.** `--apply` used `open(out_path, "w")`, which truncates the target file
   before any new bytes are written — a crash or disk-full mid-write could leave the live board
   empty or partial, with the post-write invariant never getting a chance to run. Fixed with a
   `write_atomic()` helper: write to a same-directory temp file, `flush()` + `os.fsync()` it, then
   `os.replace()` it over the target — atomic on the same filesystem, so the result is always
   either the old complete file or the new complete file.

2. **Duplicate live-board rows silently over-collapsed.** `ParsedBoard.items` was
   `dict[str, Item]` built via `items.setdefault(key, item)` — first occurrence wins. Two
   genuinely distinct rows that happen to normalize to the same first line (plausible: two agents
   independently phrasing a claim row identically) would collapse to one, and if that one key was
   already mirrored, `recover_missing_items` would treat the key as fully accounted for and drop
   the second row — the exact failure mode this tool exists to prevent, just re-introduced one
   level down. **Reproduced against the actual pre-fix script** on a scratch fixture (a mirror
   with 1 copy of a row, a live board with 2 copies of the same normalized first line but
   different bodies): the pre-fix script reported "no live-only rows found" and silently dropped
   the second copy. Fixed: `ParsedBoard.items` is now `dict[str, list[Item]]` (every occurrence,
   in document order); `recover_missing_items` and `verify_invariant` compare occurrence COUNTS
   per key instead of mere presence — if live has 2 and mirror has 1, exactly 1 is recovered
   (paired by document order, the best available heuristic without deeper content matching).

3. **No guard against a concurrent edit landing between read and write.** The live board was read
   once at the start and written at the end with no lock or recheck in between; the pre-write
   invariant check used the STALE in-memory snapshot, so it would report success while silently
   clobbering a row someone else wrote in the interim. Fixed two ways: (a) an exclusive
   `fcntl.flock` held on the live file's fd for the entire read-merge-write critical section
   (released on close, including via `finally`), which serializes concurrent invocations of this
   *same script* against each other; (b) since flock is advisory and can't stop a non-cooperating
   writer (e.g. a manual editor save), a belt-and-suspenders mtime/size fingerprint of the live
   file is captured at read time and rechecked immediately before the write — if it changed, the
   run aborts (exit 4) and writes nothing, rather than trust a merge computed from a now-stale
   snapshot.

### Verification (scratch fixtures, real live board/mirror never touched)

- Atomic write: `--apply` to a scratch `--out`; confirmed no stray `.effort-log-union-merge-*.tmp`
  files left behind afterward and the output content is correct.
- Duplicate-row recovery: built a mirror with 1 copy of a row and a live board with 2 (identical
  normalized first line, different bodies) — confirmed the FIXED script recovers exactly the
  second copy, and separately re-ran the **pre-fix** script (`git show HEAD~1:...`) against the
  same fixture to confirm it actually reproduces the loss ("no live-only rows found") — proving
  this is a real regression fix, not a hypothetical.
- Concurrent-edit guard: monkeypatched `os.stat` in-process to tamper with the live file (append a
  line, changing its mtime/size) at the moment the script's pre-write recheck calls `os.stat` on
  it — confirmed exit code 4, a clear `CONCURRENT EDIT DETECTED` message, and the `--out` target
  left completely untouched (byte-identical to before the run).
- Re-ran the real-data dry-run against the actual `docs/EFFORT-LOG.md` (used as both `--live` and
  `--mirror` to sanity-check the new count-based comparison introduces no false positives/negatives
  on the real 227-item document): "no live-only rows found" as expected, no crash.

Landed via `bash scripts/land.sh` (node@24): `npx tsc --noEmit` clean (no TS touched), `npm test`
315 files / 3383 tests, `npm run build` clean. PR #1354, squash-auto-merge armed.

## Landing-round review fix (round 2, PR #1354 — codex-autofix)

Three further codex-connector P2 comments landed on the PR. Two were fixed in this round; one
was left open as a maintainer question (a genuine merge-semantics tradeoff, not a clear bug).

1. **Rows under keyword-bearing `###` subsections were invisible (silent-drop hole).** The parser's
   `HEADING_RE` only matched level-2 (`## `) headings, so a live-only row under a nested
   `### Action - clear recommendation (Planned)` whose *parent* `## 2026-07-06 ...` heading is
   unclassified never entered a bucket — it was absent from `live.items`, so both the recovery pass
   and the pre/post invariant treated it as non-existent and `--apply` could rewrite the live board
   without it. Fixed: `HEADING_RE` now matches 2+ hashes and captures the hash run; `parse_board`
   tracks a `section_bucket` (the last `## ` bucket) alongside `current_bucket`. A `## ` heading
   resets the bucket context outright (unclassified -> None, unchanged); a deeper `###`/`####`
   heading classifies by its **own** keyword when it has one (so `### ... (Planned)` becomes
   `planned` even under an unclassified parent) and otherwise **inherits** the enclosing `## `
   section's bucket (so `### 2026-07-04 backlog ...` under `## Planned / Reserved` still counts as
   planned — no regression). **Verified** on scratch fixtures: (a) the exact codex scenario — a
   live-only row under `### Action ... (Planned)` beneath an unclassified `## 2026-07-06 ...` parent
   is now recovered into `planned`, while a `### Resolved by PR #1018 (no further action)` row (no
   keyword, unclassified parent) correctly stays ignored; (b) a no-keyword `### 2026-07-04 ...`
   subsection under `## Planned / Reserved` still inherits `planned`; (c) idempotency on the real
   `docs/EFFORT-LOG.md` (live == mirror) still reports 0 recovered and does not crash (now parses
   266 items vs the earlier 227 because previously-absorbed subsection bullets are now visible
   distinct items — a stricter, safer invariant surface).

2. **`PLAN.md` not updated for the new host-side tool.** The AGENTS.md Pre-Commit/Handoff Protocol
   requires `PLAN.md` reflect scope/approach changes before every commit; the original change added
   a new host-side reconciliation tool (plus a merge-shepherd wiring follow-up) without touching
   `PLAN.md`. Fixed: added a **"Fleet-infra tooling (host-side, no product-roadmap change)"** section
   to `PLAN.md` recording the tool, an explicit no-roadmap/no-acceptance-check-change note, and the
   merge-shepherd wiring follow-up.

3. **(Open, maintainer question — NOT auto-fixed) "Preserve live edits for mirrored rows."** Codex
   notes that when a row exists on BOTH boards under the same normalized first line but the live
   side carries a fresher edit (a state move Planned->In Progress, or an appended one-line status)
   that hasn't been mirrored yet, the count-based recovery treats the mirror occurrence as covering
   the live one, so the output keeps the stale mirror text and `--apply` overwrites the fresher live
   version. This is a real tension, but the two suggested fixes pull opposite ways relative to the
   tool's documented purpose: "preserve the live version" would break the intended
   "live fell behind the mirror -> fast-forward it while keeping live-only rows" use case, while
   "refuse when same-key content differs" would abort on nearly every run whenever the mirror lags
   live (the common case). Because choosing between mirror-wins and live-leads for shared rows is a
   core merge-semantics decision, this was left open with a PR comment asking the maintainer rather
   than guessed at.

Verification (round 2): `python3 -m py_compile scripts/effort-log-union-merge.py` clean; scratch-fixture
functional tests above; `npx tsc --noEmit` clean (no TS touched); `npm test` + `npm run build` per the
verify trio before push.

## Codex review round 3 (2026-07-10) — two more silent-drop parser holes fixed; two entangled with the open maintainer decision

Codex's third pass on PR #1354 surfaced four unresolved threads. Two are independent
parser-correctness bugs (both a silent-drop of real live-only rows — exactly the class this
tool exists to prevent) and were fixed; two are the same shared-row merge-semantics tradeoff
already parked on the maintainer and were left open.

1. **Nested classified-ancestor inheritance (`scripts/effort-log-union-merge.py` parse_board).**
   The round-2 fix tracked only the last **level-2** bucket in `section_bucket`. Codex found the
   residual hole: a live-only row under a `#### child` heading of a **keyword-bearing nested**
   section beneath an **unclassified `##` parent** (e.g. `## 2026-07-06 ...` → `### Action ...
   (Planned)` → `#### Notes` → row) reset `current_bucket` to `section_bucket` (`None`) instead of
   the nearest classified ancestor (`planned`), so the row parsed into no bucket and was invisible
   to both recovery and the invariant. Fixed by replacing the single `section_bucket` scalar with a
   `heading_bucket_by_level` map: a heading at level L closes every strictly-deeper open level, then
   classifies by its own keyword or **inherits the nearest classified shallower ancestor at any
   level** (a top-level `##` has no shallower ancestor, so it still resets outright — no regression).
   Verified on scratch fixtures: the `####`-under-`###(Planned)`-under-unclassified-`##` row now
   classifies `planned`; unclassified-`##` still resets to None; classified-`##` and keyword-less
   `###` under a classified `##` both still inherit correctly.

2. **Placeholder pattern over-broad (`PLACEHOLDER_RE`, both `effort-log-union-merge.py` and
   `sync-effort-issues.py`).** The shared regex made parentheses optional around the broad
   imperative prefixes `record the.*` and `see rollout notes.*`, so a **real** live effort row whose
   first line began that way (e.g. `Record the P&L reconciliation effort (CLAUDE)`) was treated as
   empty-section scaffolding, omitted from `live.items`, and never recovered — the invariant passed
   because it only checks parsed items. Fixed by splitting those two prefixes into a separate
   `PLACEHOLDER_PARENS_RE` that requires the wrapping parens (template scaffolding is always
   parenthesized, e.g. `(record the effort here before starting)`); the bare imperative forms now
   parse as real rows. Applied **identically to both tools** to preserve the documented "the two
   tools never disagree about what is a placeholder vs a real row" invariant.

3–4. **(Open, same maintainer decision — NOT auto-fixed.)** The two remaining threads — "Preserve
   live edits for mirrored rows" (round 2) and its duplicate-ordering variant "Preserve duplicate
   rows without order-based pairing" — are both the **same** shared-row conflict: when a key appears
   on both boards but the occurrences differ in bucket/content/order, the count-based earliest-first
   pairing can adopt the stale mirror copy over the fresher live one. Any fix (bucket-aware pairing,
   live-wins, abort-on-diff) directly changes the mirror-wins-vs-live-leads contract that is already
   parked on the maintainer via the round-2 PR comment. Guessing here would silently pick a merge
   semantics, so both stay open pending the owner's answer; a PR comment notes the duplicate-order
   thread is the same decision.

Verification (round 3): `python3 -c "import ast; ast.parse(...)"` clean on both scripts; scratch-fixture
functional tests for the nested-inheritance and bare-imperative-row cases (all pass); real-board dry-run
(`--live` = copy of `docs/EFFORT-LOG.md`, `--mirror` = same) reports 268/268 items, 0 recovered, exit 0;
`npx tsc --noEmit` clean, `npm test` 3395 passed (315 files), `npm run build` clean (no TS/product code
touched — Python-only change).

## Codex review round 4 (2026-07-10) — recovered rows landing in the wrong (nested) subsection

One new, non-outdated Codex thread (`scripts/effort-log-union-merge.py:251`, "Keep bucket insertion
points on canonical sections"). This is a **placement corruption**, distinct from the two open
maintainer-decision threads (both at line 287): the row IS recovered and the count invariant passes,
but it lands under the wrong subsection.

**Bug.** `bucket_insert_at[current_bucket]` was updated on every non-heading line inside *any*
classified section, including nested keyword-bearing subsections. So when the mirror has a canonical
`## Planned / Reserved` section followed later by a nested `### Action - clear recommendation
(Planned)` (a UI-backlog subsection under an unclassified `## ...` parent that happens to classify
`planned`), the later subsection overwrote `bucket_insert_at["planned"]`. A recovered *global*
Planned row from the live board was then inserted under that unrelated UI-backlog subsection instead
of the canonical Planned section — the board's state organization is corrupted while the count-based
invariant still passes.

**Fix.** Track a **canonical** insertion point separately (`ParsedBoard.canonical_bucket_insert_at`),
updated only while inside a section whose bucket was established by a directly-classified level-`<=2`
(`## `) heading — or inherited from such a level-2 ancestor. A parallel `heading_canonical_by_level`
map carries canonical-ness down the same inheritance chain as the bucket itself (so an unclassified
`###` under a canonical `## Planned` stays canonical, while a keyword-bearing `### ... (Planned)`
under an unclassified `##` is NOT canonical). `recover_missing_items` now prefers
`canonical_bucket_insert_at[bucket]` and falls back to `bucket_insert_at[bucket]` only for buckets
that exist **solely** as nested subsections (no canonical section at all) — preserving the round-3
nested-recovery behavior for genuinely subsection-only buckets.

**Not touched:** the two line-287 threads ("Preserve live edits for mirrored rows" and its
duplicate-ordering variant) remain OPEN — still the same mirror-wins-vs-live-leads merge-semantics
decision parked on the owner. Round 4 does not touch that contract.

Verification (round 4): reproduced the corruption on a scratch fixture (global-Planned row landed
under the nested `### Action (Planned)` subsection) and confirmed the fix relocates it under
`## Planned / Reserved`; regression fixtures — subsection-only bucket still recovers (fallback path),
and unclassified-`###`-under-canonical-`## Planned` still lands under the canonical umbrella;
real-board self-merge (`--live`/`--mirror` = `docs/EFFORT-LOG.md`) reports 268/268 items, 0 recovered,
exit 0 (no drops, parser change safe on real data); `python3 -c "import ast; ast.parse(...)"` clean;
`npx tsc --noEmit` clean, `npm test` 3395 passed (315 files), `npm run build` clean (Python-only change).

## Codex review round 5 (2026-07-11) — canonical insertion point still leaked into nested subsections

One new Codex thread (`scripts/effort-log-union-merge.py`, "Keep canonical insertions out of nested
sections"), the last unresolved thread before the PR could merge.

**Bug.** The round-4 fix tracked `current_bucket_canonical` separately from the bucket value, but
the flag was still *inherited* by unclassified subsections under a canonical parent. When the code
processed an unclassified `###`/`####` heading under `## Planned / Reserved`, it inherited both the
`planned` bucket value AND the `canonical=True` flag from level 2 via the inheritance chain
(`heading_canonical_by_level`). Every line inside that subsection then updated
`canonical_bucket_insert_at["planned"]`, so a live-only top-level Planned row was still recovered
under the last nested subsection — the round-4 fix prevented the *keyword-bearing* subsection from
hijacking the insertion point, but the *unclassified* subsection could still do it because it
carried the canonical flag via inheritance.

**Fix.** When an unclassified heading inherits its bucket from a shallower ancestor, do NOT
propagate the canonical flag. Set `effective_canonical = False` in the inheritance branch
(scripts/effort-log-union-merge.py:271), so the `heading_canonical_by_level` entry for the subsection
level is `False`. Lines inside that subsection then only update `bucket_insert_at`, not
`canonical_bucket_insert_at` — the canonical insertion point stays where it was at the end of the
direct level-2 content, and recovered top-level rows land before any nested subsections.

This does NOT affect directly-classified level-3 headings (e.g. `### Action ... (Planned)` under an
unclassified `##` parent) — those already set `effective_canonical = level <= 2 = False` in the
classified branch. It only changes the inheritance path.

**Not touched:** the two line-287 threads ("Preserve live edits for mirrored rows" and its
duplicate-ordering variant) remain OPEN — still the same mirror-wins-vs-live-leads merge-semantics
decision parked on the owner. Round 5 does not touch that contract.

Verification (round 5): `python3 -m py_compile scripts/effort-log-union-merge.py` clean; logical
review confirms the inheritance-only change is correct and has no side-effects on classified
headings or unclassified top-level headings; the two open maintainer-decision threads untouched;
`npx tsc --noEmit` clean, `npm test` 3433 passed (317 files), `npm run build` clean (Python-only
change — no TS/product code touched).
