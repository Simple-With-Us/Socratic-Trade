# Qdrant delta sync runbook (post Sep-1 cutover)

Read this alongside the docstrings in `pinecone-to-qdrant-copy.py` and
`sentinel-backfill.py` — this file is the *procedure*, those files are the
*mechanism*.  Nothing here should contradict the code; if it ever does,
trust the code and fix this doc.

## Why a delta pass exists at all

The 2026-08-28 run was a snapshot copy: it read whatever existed in Pinecone
while it ran.  Anything written to Pinecone during or after that run — new
filings ingested between 08-28 and the Sep-1 cutover — is not yet in Qdrant.
Point ids are deterministic (`uuid5("st:" + namespace + ":" + pinecone_id)`),
so re-running the copy script is a safe, idempotent way to pick up exactly
those new/changed records without duplicating anything already copied.

## Prerequisites

- `PINECONE_API_KEY`, `QDRANT_URL`, `QDRANT_API_KEY` in the environment.
  Never `cat`/`grep '^[A-Z_]*='` a secrets handoff file to get these — read
  them from the `chmod 600` path the owner gave you, or from the running
  container per the pattern in this repo's agent instructions.
- The 08-28 run's state/log files, if you still have them:
  `qdrant-copy-state.socratic-trade.socratic-trade.json` and its `.log`
  sibling.  **Keep the state file** — see "Why keep the state file" below.
  If you don't have it, the delta pass still works, it just costs a full
  rescan (see the timing table).
- The Hetzner box (Qdrant + prod) must be up.  It was scheduled for a
  ~5-15 minute power-off for a disk upgrade around the time this runbook was
  written; if calls refuse, that's the planned maintenance, not a code bug —
  retry after it's back (`docker ps` on the box, or the `/collections/socratic-trade`
  health check in the SSH pattern documented in this repo's CLAUDE.md).

## Why keep the state file (don't delete it for a delta run)

`done_ns` now records the Pinecone `vectorCount` each namespace had when it
finished, not just its name (see the copy script's module docstring for
detail).  On a re-run:

- A namespace whose `vectorCount` is **unchanged** since it was marked done
  is skipped after one cheap `describe_index_stats` lookup — no
  `/vectors/list` or `/vectors/fetch` calls against it at all.
- A namespace that **grew**, or is **brand new**, is rescanned in full.
  Pinecone has no "list ids added since timestamp" API, so a grown
  namespace still costs a full re-list of its own ids — but points already
  copied are cheap no-ops on the Qdrant side (same deterministic id, same
  vector/payload, `wait=true` upsert just re-acknowledges).

Deleting the state file forces every namespace to be treated as unseen,
which is a correct but expensive way to run a delta — it repeats the full
08-28 read volume against Pinecone for zero new data in the common case.
Only delete it if the state file is lost, corrupted, or you deliberately
want a from-scratch reconciliation.

## Step-by-step: Sep-1 delta procedure

1. **Re-run the copy script**, from the same working directory the 08-28 run
   used (so it finds the existing state/log files by their default
   `qdrant-copy-state.<INDEX>.<COLLECTION>.json` / `.log` names), or pass
   `COPY_STATE=/path/to/that/file.json` explicitly:

   ```bash
   export PINECONE_API_KEY=... QDRANT_URL=... QDRANT_API_KEY=...
   python3 scripts/qdrant/pinecone-to-qdrant-copy.py
   ```

   This is a **fresh read against Pinecone** — it costs real Pinecone read
   units even for namespaces it ends up skipping (one stats call covers all
   namespaces at once; only non-skipped namespaces cost list/fetch calls).
   Do not run this speculatively; run it once, close to the actual Sep-1
   cutover.

2. **Re-run the sentinel backfill.**  Any point copied by step 1 is a brand
   new Qdrant point and will already carry whatever payload Pinecone had —
   but if Pinecone's metadata predates the `scope` / `tenant_scope` /
   `receipt_required` / `as_of_epoch_ms` sentinel fields, the newly-copied
   points will be missing them just like the pre-08-28 backfill population
   was.  Always re-run this after step 1, even if step 1 reports few new
   points:

   ```bash
   export QDRANT_URL=... QDRANT_API_KEY=...
   python3 scripts/qdrant/sentinel-backfill.py --dry-run   # check counts first
   python3 scripts/qdrant/sentinel-backfill.py             # apply
   ```

   This never overwrites an existing value — it's safe to run even when
   step 1 copied zero new points.

3. **Re-run the golden eval** (whatever script/process validates retrieval
   quality against the golden query set — see the retrieval/RAG docs in
   `docs/` for the current eval entry point) to confirm Qdrant's answers
   haven't regressed after the delta lands.

## Expected timings

| Pass | 08-28 (full corpus) | Sep-1 (delta) |
|---|---|---|
| Copy script | ~801,239 points, ~1 day wall-clock (Pinecone read-bound, `WORKERS=6`) | Minutes, assuming most namespaces are unchanged (per-document namespaces are effectively immutable once ingested) — cost scales with *new/changed* namespaces only, not total corpus size |
| Sentinel backfill | N/A (fields didn't exist as a gap yet at that point / ran separately) | Seconds to low minutes — scoped to whatever the copy step just added; `--dry-run` first to confirm the count before applying |
| Golden eval | N/A | Whatever the existing eval suite normally takes |

If the delta copy pass takes anywhere near the 08-28 full-run duration,
something is off — check the log (`COPY_LOG`, default
`qdrant-copy.<INDEX>.<COLLECTION>.log`) for `NAMESPACE-INCOMPLETE` lines or
an unexpectedly large number of namespaces being rescanned (would show as
repeated `progress` lines for namespaces that shouldn't have grown), and
confirm the state file being read is actually the 08-28 one and not a fresh
empty state (wrong `COPY_STATE` path is the most likely cause).

## Caution: Pinecone reads before Sep 1 will 429

Do not dry-run, test, or "just check" the copy script against the live
Pinecone index before the actual Sep 1 cutover window — reads before that
date will be rate-limited/429'd (read-unit budget is reserved for the
cutover itself).  The sentinel backfill script talks only to Qdrant and has
no such restriction — its `--dry-run` mode is safe to run anytime the
Qdrant box is up, and was used to verify this runbook (see verification
note below).

## Verification performed while writing this runbook

- `python3 -m py_compile` clean on both `pinecone-to-qdrant-copy.py` (after
  the `done_ns` change) and `sentinel-backfill.py`.
- `sentinel-backfill.py --dry-run` run against the live collection
  (`socratic-trade`, 801,239 points): all four sentinel fields reported 0
  points missing, matching a manually inspected sample payload that already
  carries `scope`, `tenant_scope`, `receipt_required`, and `as_of_epoch_ms`.
  This confirms the backfill script's filter/logic work correctly against
  real data today; it also means there is currently nothing to backfill —
  the script exists for whatever gap the Sep-1 delta copy introduces.
- The `done_ns` vectorCount-gating change was sanity-checked in isolation
  (list-to-dict migration and match/mismatch skip logic) rather than against
  a live re-run, per the "no Pinecone reads before Sep 1" caution above.
