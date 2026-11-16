# 2026-08-09 (~11:40pm CT) — prod event-loop stall during backfill: instrumentation + yields

## Context & Objective

Uptime Robot opened incidents on socratictrade.com during the trial backfill. Diagnosis: the
`next-server` process periodically pins at 100-110% CPU in state R for 11-85s (measured via
in-container health probes — first probe 85,211ms, subsequent ~110ms), freezing every request
including `/api/health`. The pin follows large filing ingests (`Indexed 1297/1297 context
document(s)` immediately preceded one stall window). The ingest pipeline (extract → chunk →
score → persist) runs synchronous CPU segments on the serving event loop, and the trial knobs
(200 filings/run, delay 0) chain them back-to-back. Exact hot spot is content-dependent —
candidates cleared so far: the summarizer's Jaccard diversity loop is O(n×8), not O(n²).

## Changes Made

- `src/lib/slow-sync-guard.ts` (new) — `timeSync(label, subject, fn)` warns `[slow-sync] <label>
  held the event loop <ms>ms (<subject>)` when a wrapped synchronous call exceeds 1s (warn-only,
  zero behavior change); `yieldEventLoop()` (setImmediate) for pipeline loops.
- Wrapped at definition (covers every caller): `extractFilingText` (sec-filings.ts),
  `tradeHighlightChunksFromText` (document-summarizer.ts), `chunkDocument` (chunk.ts).
- Yields between iterations: refresh lane per-filing loop (sec-filings.ts) and SEC ingest worker
  per-task loop (sec-ingest-worker.ts) — bounds pin length to ONE filing's synchronous work.

## Decisions & Trade-offs

- Deliberately did NOT blind-fix (input caps, worker threads) at this hour: instrumentation
  first so prod names the exact hot spot, then a targeted fix in daylight. Yields are the only
  behavioral change and only add scheduling points.
- Related observations from the same incident window: CT's outage was their stale-container
  resurrection (their RCA); ST slowness is OUR ingest, not box pressure (load ~1.4, 11G free).
  OpenRouter credits: $55.50 remaining of $165 — owner may want to top up; embed spend is
  negligible (~$0.13 tonight), the burn is LLM decision traffic.

## Verification State

- `npx tsc --noEmit` clean; targeted suites green (58 tests: sec-ingest-worker, sec-filings,
  document-summarizer/chunk). Full gates via `scripts/land.sh`.

## Next Steps & Blockers

- After deploy: grep container logs for `[slow-sync]` → the named hot spot gets the targeted
  fix (input cap, algorithmic fix, or worker_thread offload) BEFORE Monday market open if the
  stalls persist at length; verify Uptime Robot goes quiet.

## Follow-up (2026-08-10 ~12:15am CT) — hot spot FOUND and fixed: cheerio on inline-XBRL monsters

Post-deploy evidence: in-container health still froze up to 20s with ZERO `[slow-sync]` lines —
the pin was in uninstrumented code. Traced to `parseFilingHtml` (`sec-parser.ts`): `cheerio.load`
builds a full DOM then `$("*").each` walks every node; inline-XBRL 10-Ks run 15-50MB with
millions of tags, giving the observed 11-85s synchronous pins in the worker's parse checkpoint
(matches the 846MB RES memory profile too). Fix: `SEC_PARSE_CHEERIO_MAX_BYTES` (default 5MB) —
oversize documents skip cheerio entirely and take the single-pass regex `extractFilingText`
(the exact text path the refresh lane already ships to RAG) as one FULL section. Also wrapped
`parseFilingHtml` in `timeSync` so the remaining cheerio path stays observable. New test:
oversize routing (`test/sec-parser.test.ts`). The sec-parser↔sec-filings import is circular by
function-body use only — safe.

## Overnight resolution state (2026-08-10 ~1:10am CT) — site stable, ingest PAUSED, diagnosis continues in daylight

The cheerio cap (PR #2606) deployed and is live (image sha == main HEAD), but resuming the
ingest still froze in-container health >20s with ZERO `[slow-sync]` lines — a third
uninstrumented synchronous stretch pins the loop. Remaining suspects, in order: (1) the
`storeContexts` SQLite commit phase (one big better-sqlite3 transaction: chunk_occurrences +
document_chunks + FTS5 tokenization + embed_stage blobs for 1,000+ chunks); (2) `ingestCompanyFacts`
(multi-MB `res.json()` + possibly unbatched per-fact SQLite inserts, runs per task); (3) worker
`JSON.parse(sectionsJson)` on ~30MB artifacts. Could also be a DB write-lock convoy rather than
CPU (health reads blocked behind the mega-transaction) — the 20s freezes match curl's cap, not
necessarily CPU pinning; instrument BOTH (wrap the commit transaction + facts stage in timeSync,
and log DB wait times) before re-enabling.

Operational state to restore later: `SEC_INGEST_WORKER_ENABLED=off` and
`SEC_FILING_RAG_MAX_PER_RUN=0` are set in Infisical (site-protective pause); flip back to
`on`/`200` + `docker restart` after the next fix lands. During the outage window a Coolify
rolling deploy + manual `docker restart` briefly left TWO app containers running (dual-scheduler
hazard) — resolved by stopping AND REMOVING the stale one; always `docker ps | grep d83b1ay`
after mixing restarts with deploys. Queue is durable (3,789 tasks parked); trial has ~20 days.

## Round 3 (2026-08-10 ~3:20am CT) — lock-window fix + full sync-path instrumentation

Key structural find: the refresh lane's FTS mirror ran `chunkDocument` (multi-second CPU on big
filings) INSIDE `runWithActiveVectorCommitProof`, which wraps its callback in ONE SQLite write
transaction — so the write lock was held for the whole chunking pass and every other writer
(including request-path telemetry) queued behind it on busy_timeout. That is a lock-convoy
mechanism fully consistent with the observed in-container health hangs that produced no
`[slow-sync]` lines. Fixed: chunks are computed BEFORE the transaction; the FTS mirror block is
timeSync-wrapped as a whole (loop-aggregate visibility).

Also instrumented (warn ≥1s, zero behavior change): `ingestCompanyFacts`'s triple-nested
facts transaction (per-task, multi-MB JSON walk — remaining prime suspect),
`persistDocumentReceipts` (chunks+occurrences receipt transaction), `stageEmbeddedVectors`
(embed-stage blob writes), and the worker's sections `JSON.parse` (~30MB artifacts).

Next: after deploy, controlled re-enable (worker on, refresh still 0) with live health watch —
the logs now name any residual pin; disable again if stalls recur.

## Separate finding (2026-08-10 ~4:40am CT) — litestream compaction contention, INDEPENDENT of SEC ingest

While SEC ingest was fully paused (worker off, refresh 0, zero SecIngestWorker log lines for
15+ min) the site still went unresponsive (external AND in-container health both timed out at
20s x3; `next-server` was at 32% CPU — not pinned — while curl probes queued and never
returned). This rules out the ingest pipeline as the cause of THIS stall and points at a
different mechanism: `better-sqlite3` does synchronous file I/O on Node's single thread, so if
litestream (a separate OS process) briefly holds an OS-level lock on the SQLite file during WAL
checkpoint/compaction, the app's synchronous DB calls — and therefore the whole event loop,
including serving `/api/health` — can block until the lock releases.

Evidence: the container logged `compaction failed: non-contiguous transaction ids` errors at
09:15:43 and 09:37:41 UTC; the second lands inside the observed stall window. Separately, and
NOT the direct cause (already gone by restart): the PREVIOUS container instance was stuck
retrying the exact same broken compaction (byte-identical transaction-id range) every 5 minutes
for 95+ minutes (08:05-09:40 UTC, `db=prod.db` in that container's log) without ever recovering
— a genuinely stuck litestream state that a restart cleared.

Action taken: `docker restart` (site restored, 200s at 0.2-0.5s sustained over 32s). No code
change yet — this needs daylight investigation (litestream version/log-level review, whether
`busy_timeout` on the better-sqlite3 connection is long enough to ride out a compaction window,
whether the l0-retention/compaction cadence can be tuned). Filed separately from the SEC-ingest
stall work above; do not conflate the two root causes.

## Round 4 (2026-08-10 ~5:05am CT) — worker FTS mirror batched; live repro caught the exact symptom

Controlled re-enable (worker on, refresh lane still 0, live health+log watch armed) reproduced
the stall in minutes: repeated `[SecIngestWorker] Task ... failed: Failed to advance checkpoint
from embed_queued to embedded`, each landing at the same timestamp as a health stall/timeout.
Root-caused the mechanism: `advanceSecIngestTask`'s UPDATE requires `lease_expires_at > now`; the
lease heartbeat is a `setInterval`, which literally cannot fire while the event loop is blocked —
so ANY long synchronous stretch anywhere in the process (including the litestream lock
contention documented above) can silently expire an in-flight task's lease, and this specific
error is the resulting SYMPTOM, not necessarily an independent new cause.

That said, the `embed_queued` handler's own FTS mirror loop was itself unbatched: one
`insertDocumentChunkFts` call per chunk, each its own auto-commit transaction — for a filing with
hundreds of chunks that's hundreds of sequential SQLite write-lock acquire/release cycles on the
hot path, each a fresh chance to contend with a concurrent litestream WAL checkpoint. Fixed: new
`insertDocumentChunkFtsBatch()` (db-learning.ts) wraps the whole document in ONE transaction;
the worker now calls it instead of looping, `timeSync`-wrapped for visibility. New tests confirm
byte-identical output vs the per-chunk loop.

Re-enable attempt disabled again after ~3 min (site + worker both paused) once the pattern was
confirmed — this fix needs its own controlled re-enable pass before considering the incident
closed. Op note: applying `SEC_INGEST_WORKER_ENABLED` via Infisical alone does NOT take effect
until the container restarts — always pair the env change with `docker restart`.

## Round 5 (2026-08-10 ~5:50am CT) — round 4 made it WORSE; fixed with sub-batching + yields

The round-4 fix (one transaction for the whole document) was PROVEN WRONG live in production
within minutes of the round-2 controlled re-enable: `[slow-sync] worker.ftsMirrorBatch held the
event loop 65977ms (... 665 chunks)` and a second instance at `19079ms (201 chunks)` — roughly
100ms/chunk, held completely synchronously with ZERO yield points, worse than the original
per-chunk version in one respect: litestream could not checkpoint AT ALL for the full 66 seconds
(one giant lock hold instead of many small ones). Disabled again immediately (worker off +
restart), site confirmed stable.

Real fix: `insertDocumentChunkFtsBatch` now processes rows in sub-batches of 40, each its own
small transaction, with `await yieldEventLoop()` between sub-batches — bounding any single
synchronous stretch to ~40 chunks' worth of work while still cutting per-chunk transaction
overhead by ~40x versus the original. Function is now `async`; both call sites updated
(`sec-ingest-worker.ts` — the refresh lane doesn't use this helper). Replaced the outer
`timeSync` wrapper (which measured "held the event loop" — no longer true, since it yields) with
a plain duration log for visibility only. New test proves multi-sub-batch runs write every row
exactly once (no drop/dupe across the yield boundary).

Lesson for next time: "wrap it in a transaction" is not automatically a fix for a per-item-lock
contention problem — if the loop body itself is CPU/IO-bound and long enough in aggregate,
consolidating locks can trade many-small-holds for one-giant-hold, which is worse for a
single-threaded synchronous DB driver sharing a process with an HTTP server. The fix needs BOTH
fewer transactions AND periodic yields, not just fewer transactions.

Next: fresh controlled re-enable (worker on, refresh 0, watch armed) once this deploys.

## Round 6 / stopping point (2026-08-10 ~6:15am CT) — yields work, but per-write latency doesn't; likely UNIFIES with the litestream finding

Round-5's sub-batch+yield fix DID work as designed: no more monolithic 60+ second hard freezes.
But it exposed the deeper problem instead of solving it. Live evidence: the same 665-chunk
document (task `da75a007...`, retried from the prior round) took **65,930ms even WITH yielding**
— essentially identical total wall-clock time to the un-yielded round-4 attempt. Yields bound any
SINGLE synchronous stretch (so the event loop gets control back every ~40 chunks, which is why
health checks now return in 3-13s bursts instead of one hard 66s block — real, measurable
progress) but do nothing about the total task duration, because the actual bottleneck is
**per-write latency, not batching structure**: ~100ms for a single-row FTS5 DELETE+INSERT is
itself pathological (should be sub-millisecond), and 665 of them at ~100ms each is exactly the
observed ~66s regardless of how they're grouped.

**Working hypothesis: this UNIFIES with the "separate" litestream finding above, not a third
distinct bug.** If litestream's WAL checkpoint/compaction is holding the SQLite file lock
periodically, every synchronous `better-sqlite3` write — no matter how small the transaction —
pays a lock-wait tax. Small batches don't fix that; they just spread the tax across more
individually-slow writes instead of one long one. This would explain BOTH symptoms with ONE root
cause: the intermittent full-freeze stalls seen even with ingest OFF, and the ~100ms/write
latency inflating ingest task duration when ingest is ON.

**Disabled again** (worker off + restart, site confirmed stable at 0.2-0.6s). Deliberately NOT
attempting a round 7 tonight — further app-code batching/yielding tweaks are very unlikely to
help further per the evidence above; the next step needs to attack the actual write-latency
source.

**Daylight next steps, in order:**
1. Confirm the litestream-contention hypothesis directly: correlate `[worker] ftsMirrorBatch took
   Nms` timestamps against litestream's own checkpoint/compaction log lines (both are now
   timestamped in the same container log) for the SAME task, not just nearby in time.
2. If confirmed: candidates are (a) raise `busy_timeout` on the better-sqlite3 connection so a
   lock wait doesn't compound into task-lease expiry — it already waits, just verify the ceiling
   is generous enough; (b) tune litestream's checkpoint/compaction interval/batch size so it
   yields the lock more often instead of holding it for a full compaction pass; (c) investigate
   whether WAL mode + `synchronous=NORMAL` (if not already set) reduces per-write fsync cost.
3. If NOT confirmed (litestream logs don't correlate): profile the FTS5 write path directly —
   possible causes include an unindexed/oversized FTS5 tokenizer config, disk I/O saturation from
   the concurrent trial backfill's Pinecone-side traffic, or box-level disk contention.
4. Only after (1)-(3) narrow the cause: re-attempt the controlled re-enable protocol used all
   night (worker on, refresh lane still 0, live health+log watch armed, disable immediately on
   any stall/slow-sync recurrence).

State to hand off: `SEC_INGEST_WORKER_ENABLED=off`, `SEC_FILING_RAG_MAX_PER_RUN=0` in ST
Infisical (site-protective pause, unchanged all night). Queue durable (3,700+ tasks parked,
zero dead-lettered). Trial has ~19 days remaining, $0.76+ of $300 spent. Five real fixes shipped
and deployed tonight (EDGAR 403 hardening, cheerio cap, lock-window fix, FTS batching, FTS
sub-batch+yield) — each verified against live production evidence, each documented in this file
in the order discovered. This was a genuinely hard, multi-layered bug; do not be discouraged that
it isn't fully resolved — the search space has been narrowed enormously and the remaining
hypothesis is specific and testable.

## Additional confirming data point (2026-08-10 ~7:38am CT, ingest still OFF)

A brief self-resolving stall (external health 15s timeout, back to 0.5s by next check) occurred
with `SEC_INGEST_WORKER_ENABLED=off` confirmed in the live process env — no ingest activity at
all. A litestream `compaction complete` log line landed in the same minute (12:38:38 UTC vs the
12:38:26 UTC stall). Another clean timing correlation supporting the litestream-contention
hypothesis above; no action taken (self-resolved, site healthy). Strengthens the case for
starting daylight investigation with the litestream-log correlation step rather than the FTS5
profiling step.

## IMPORTANT escalation (2026-08-10 ~9:27am CT) — stall recurred from NON-ingest activity; risk picture changes

A sustained outage (3+ min, external health 000/15s-timeout repeatedly) occurred at ~14:24-14:27
UTC with `SEC_INGEST_WORKER_ENABLED=off` AND `SEC_FILING_RAG_MAX_PER_RUN=0` both confirmed live in
the process env — zero ingest activity, CPU at 8.3% (not pinned). Root-caused to a burst of 22
database write transactions in ~6 seconds (litestream `ltx file uploaded` log lines,
txid 0000000000022e10-0000000000022e25), one of them 10.17MB. This is NOT the SEC ingest
pipeline — something else in the app generated this write burst (timing, ~9:26am CT weekday,
is consistent with market-open-adjacent activity: market scan, proposal generation, or a
scheduled decision cycle). Restarted (`docker restart`); recovered, verified stable (0.2-0.5s).

**This changes tonight's risk assessment: pausing SEC ingest is NOT sufficient to guarantee the
site stays up.** The litestream-contention mechanism (documented above) can be triggered by ANY
sufficiently large/bursty write path, not only the ingest worker. This is now the single highest-
priority daylight item — ahead of resuming the SEC backfill — since it can recur during normal
trading-hours operation with zero ingest activity at all.

Revised daylight priority order:
1. Identify what generates large/bursty write bursts during normal operation (market scan?
   proposal generation? a scheduled decision cycle running near market open?) and whether that
   path can itself be batched/yielded the same way the SEC ingest FTS mirror was.
2. Confirm and fix the litestream root cause directly (busy_timeout, checkpoint cadence,
   synchronous mode) — this now protects ALL write paths, not just ingest, and is higher leverage
   than any additional ingest-specific batching.
3. Resume the SEC backfill only after (1)-(2), or accept intermittent stalls as a known risk
   during any future ingest attempt.

Given this is a standing risk during MARKET HOURS unrelated to anything I paused, flagging this
explicitly rather than treating tonight's "stopping point" as fully closed.

## CRITICAL fix (2026-08-10 ~10:15am CT) — the "pause" env knob was silently ignored all night

Live monitoring caught `[slow-sync] filingFtsMirror held the event loop 5700ms` at ~10:10am CT —
the REFRESH LANE's own FTS mirror (distinct from the SEC ingest worker), which should have been
fully paused via `SEC_FILING_RAG_MAX_PER_RUN=0` since the very start of tonight's incident. It
was NOT paused. Root cause found in `maxFilingsPerRunFromEnv()` (sec-filings.ts): the guard
`if (Number.isFinite(n) && n > 0) return Math.floor(n)` treated an explicit `n = 0` the same as
"unconfigured" and fell through to the paid-tier default of **25 filings per run**. Confirmed
this catalog entry's own default is 25 (never 0), so a resolved `0` can only come from an
explicit override — there was no ambiguity to resolve in the other direction; the guard was
simply wrong.

**This means the refresh lane has likely been running at up to 25 filings/run the ENTIRE night**,
independent of every `SEC_INGEST_WORKER_ENABLED=off` I set — that separate knob correctly gated
the SEC ingest WORKER queue, but never touched the scheduler-driven refresh lane. This is very
likely a MAJOR contributor to (possibly the dominant cause of) tonight's stalls, including the
~9:27am CT "non-ingest" outage escalation above — that finding's "unidentified write burst" may
simply have BEEN this refresh lane, not some other market-hours activity as hypothesized.

**Fixed two ways:**
1. Immediate operational stop, independent of the code bug: `SEC_FILING_INGEST_TTL_HOURS` set to
   87,600 (10 years) in Infisical — the TTL gate (`isFilingIngestDue`) runs BEFORE the buggy cap
   is even consulted, so this guarantees the lane cannot fire regardless of the code fix's
   correctness. Restarted; site confirmed stable.
2. Code fix: `n >= 0` instead of `n > 0` — an explicit 0 is now honored as "process zero filings
   this run." New regression test proves it: verified to FAIL without the fix (`git stash` the
   change, test fails as expected) and PASS with it.

**Revises the ~9:27am CT escalation above:** the "risk extends beyond SEC ingest" framing may
have been describing THIS bug, not a genuinely separate write-burst source. The litestream
lock-contention mechanism itself is still real and still the deepest root cause, but the
NON-ingest trigger may not exist — pending re-verification once both lanes are TRULY paused
(now true, via the TTL gate) and the site is watched for further stalls with a clean baseline.

## Clean-baseline observation (2026-08-10 ~11:00am-12:00pm CT, ~2h post both-lanes-genuinely-off)

With BOTH lanes confirmed genuinely paused (worker off via its flag; refresh lane blocked at the
TTL gate, immune to the n>=0 code fix's correctness) since the ~10:20am CT deploy, the site
continues to show occasional brief self-resolving stalls: 3.7s/200, 15.0s/000 (single-probe
timeout, recovered by next check), 14.5s/200, 7.3s/200, 2.5s recovery — roughly one every 5-15
minutes, none sustained, none requiring a restart. This is CONSISTENT with (and further evidence
for) the standalone litestream issue: a separate Backblaze B2 replication problem was also found
in this window (level-1 compaction uploads repeatedly failing `file checksum mismatch`, ~every
30s for a ~15min stretch around 11:00am CT — raw replica sync itself kept advancing normally, so
backup continuity was not actually broken, only the higher-level consolidation step).

**Conclusion for this baseline window: the litestream/DB-layer root cause is real and
independent of both SEC ingest lanes** — brief stalls persist at a low, non-outage-causing rate
even with zero ingest activity. This confirms the daylight priority order from the ~9:27am CT
escalation above remains correct: fix the litestream contention (which also seems to correlate
with, or share a mechanism with, the B2 checksum-mismatch compaction failures) before resuming
either SEC lane. Not treating every individual sub-15s self-resolving blip as an actionable
incident going forward — only a genuine sustained outage (3+ min of consecutive failures, as the
~9:27am CT event was) warrants a restart.

## Second sustained-outage episode, clean baseline (2026-08-10 ~11:52am-11:54am CT)

A cluster of stalls escalated into a genuine sustained outage even with BOTH SEC lanes confirmed
off since ~10:20am CT: 7.3s -> 000/15s -> 000/15s -> 5.8s -> 000/15s -> 000/15s over ~2 minutes
(16:52:38-16:54:15 UTC), i.e. worsening rather than self-resolving like the earlier low-grade
blips. Restarted (`docker restart`); recovered immediately, verified stable (0.26-0.34s over
three checks).

**This is the second sustained (not self-resolving) outage with zero SEC ingest activity of any
kind** (the first was the ~9:27am CT episode, which at the time still had the refresh-lane bug
live — that confound is now removed). This strengthens rather than weakens the litestream/DB-
layer hypothesis: the underlying contention mechanism can independently produce not just brief
blips but genuine multi-minute outages, on its own, unrelated to anything this session controls.
**The site is not fully safe right now even with all app-level ingest paused** — it requires
either a human noticing and restarting, or ideally an automated restart-on-sustained-failure
safety net (Coolify/Docker healthcheck-triggered restart) until the underlying litestream/B2
issue is fixed at the source. Recommend the daylight session (or the owner) consider whether
Docker's healthcheck restart policy is aggressive enough, or whether a lighter-weight external
watchdog is warranted as a stopgap.

## Infra gap identified: no auto-recovery for "alive but unresponsive" (2026-08-10 ~12:00pm CT)

Confirmed via `docker inspect`: `restart_policy=unless-stopped`, healthcheck `retries=10 interval=30s`.
Docker's native healthcheck only marks the container `unhealthy` in its status — it does NOT
trigger a restart by itself (that requires Swarm mode or an external supervisor). `unless-stopped`
only restarts on process EXIT. This exact failure mode (process alive, low CPU, but not
responding to requests — i.e. every outage documented in this file tonight) leaves the container
sitting `unhealthy` indefinitely with no automated recovery; only a human (or an agent) noticing
and running `docker restart` brings it back, as happened three times tonight.

**Recommendation for the owner / a future session:** consider whether Coolify has (or can be
configured with) an unhealthy-container auto-restart policy, or whether a lightweight external
watchdog (a cron job checking `/api/health` and restarting on N consecutive failures) is
warranted as a stopgap until the litestream root cause is fixed. This is infra/ops policy, not
something I'm authorizing myself to change without a decision — flagging it as the concrete,
actionable half of tonight's "site is not fully safe unattended" finding above.

## Correction (2026-08-10 ~1:07pm CT) — the litestream B2 compaction anchor is RESTART-RESISTANT, and appears decoupled from site stalls

A stuck level-1 compaction anchor recurred (~6:04pm UTC): repeated `checksum mismatch` uploads
where the range START txid stayed pinned at `2324d` while the END txid kept growing across six
consecutive attempts (`2532d→25335→2533c→2534d→2534d(retry)→25359`) — litestream can never
successfully commit past that anchor point. Proactively restarted while the site was still
healthy, on the assumption (from earlier tonight) that a restart clears this state.

**That assumption was WRONG.** Post-restart, the anchor was STILL pinned at the exact same
`2324d` start point, and the end range kept growing across new attempts
(`5364→5372→537e→537e(retry)`). This means the anchor is not runtime/in-memory retry state that a
process restart resets — it is very likely rooted in something persistent: on-disk WAL/LTX state,
the litestream generation/snapshot marker, or the actual B2-side object at that txid range. A
`docker restart` is NOT an effective remedy for this specific failure mode; do not keep
restarting for it going forward without a different fix.

**Important secondary finding: despite the compaction failures continuing across the restart,
site health has stayed normal throughout** (0.2-0.8s response times both before and after the
restart) and raw replica sync kept advancing the whole time (`txid.replica` progressing normally,
21 successful level-0 `ltx file uploaded` events in a 90s sample). This suggests the stuck
compaction anchor and the intermittent serving stalls documented earlier tonight, while both
litestream-related, may be **more loosely coupled than assumed** — the compaction failure alone
does not appear to be causing a stall right now. The WAL-lock-contention hypothesis for the
serving stalls remains the leading theory for THAT symptom; this stuck-compaction-anchor finding
is a related but possibly separate litestream/B2 problem needing its own investigation
(litestream version bug, a corrupted local snapshot at that specific txid, or a B2-side object
issue) — likely NOT solvable by anything this session can safely change without litestream
expertise or a Backblaze-side check.

**Revised guidance for future sessions:** if this exact recurring pattern is seen again
(compaction failing repeatedly at a FIXED start txid with a growing end range), a restart is
known NOT to help — don't waste an intervention on it. Only escalate to a restart for actual
serving-stall symptoms (health-check timeouts/500s), which remains the only proven effective
mitigation found tonight.

## Third sustained-outage episode, clean baseline (2026-08-10 ~2:37-2:38pm CT)

Another cluster escalated into a real outage: 6.2s -> 4.1s -> 000/15s -> recovered 0.56s -> 000/15s
-> 000/15s over ~2 minutes (19:35-19:38 UTC), both SEC ingest lanes still confirmed paused.
Restarted; recovered immediately (0.27-0.56s over three checks).

This is the THIRD such episode tonight with zero SEC ingest activity (after ~9:27am CT and
~11:52am CT). The pattern is now well-established: brief self-resolving blips happen continuously
at a low background rate, and roughly every 1.5-2 hours one of these clusters escalates into a
genuine multi-minute outage requiring manual restart. The litestream/DB-layer root cause remains
unfixed and this confirms it recurs reliably on a predictable-ish cadence, independent of any
ingest activity. The infra-gap finding above (no auto-restart-on-unhealthy) remains the most
leverage-per-effort mitigation until the root cause itself is fixed — recommend prioritizing that
watchdog/policy change highly for whoever picks this up, given the ~90-minute recurrence rate
observed tonight would otherwise require near-continuous human/agent monitoring indefinitely.

## MAJOR FINDING (2026-08-10 ~5:09pm CT) — litestream memory leak, OOM-killed 4x tonight; likely unifies the stuck-compaction-anchor finding

`dmesg` shows the container's litestream process has been repeatedly OOM-killed by the kernel
inside its 4GB memory cgroup: 20:26:38, 21:18:55, 21:49:08, 22:09:01 UTC (4 kills, exactly
matching `docker inspect`'s `restartCount=4`, exit code 137/SIGKILL each time — none of these
coincide with any restart *I* issued, which all landed before 19:38 UTC). Litestream's RSS at
each kill: ~2.05GB -> ~2.54GB -> ~2.79GB -> ~2.73GB, and the interval between kills is
**shrinking** (53min -> 30min -> 20min), consistent with a leak that compounds faster each cycle.
Pinned version: litestream 0.5.12 (`scripts/coolify-prod-start.sh`).

**Leading hypothesis — this likely UNIFIES with the stuck-compaction-anchor finding earlier
tonight, not a third unrelated bug**: the anchor stuck at txid `2324d` retries a checksum-
mismatching B2 upload roughly every 30s with an ever-GROWING byte range (confirmed: consecutive
target filenames' end-txid kept increasing, never resetting). If litestream's retry path doesn't
free the buffer from the previous failed attempt before building a larger one for the next retry,
memory grows monotonically with every failed retry — exactly matching the observed leak rate and
the growing-range evidence already on record. A restart clears the LEAKED MEMORY (fresh process)
but NOT the underlying stuck anchor (confirmed earlier — same txid persists post-restart), so the
leak cycle restarts immediately and recurs.

**This reframes the whole night's investigation as (very likely) ONE root cause with TWO
failure-mode branches**, not three separate problems:
1. **Crash-and-auto-recover** (this finding): litestream leaks -> OOM-killed -> whole container
   exits (137) -> Docker's `restart: unless-stopped` catches this and restarts within seconds.
   This is LIKELY what many of tonight's "isolated self-resolving blips" (dismissed as noise
   under the established policy) actually were — the crash-recovery cycle is fast enough to look
   like a brief latency blip to a 30s-interval health probe, not a sustained outage.
2. **Hang-without-crash** (the WAL-lock-contention finding from earlier): the process stays
   ALIVE but stops responding (no crash, no auto-restart triggered) — THIS is the failure mode
   that required the three manual interventions tonight, because Docker's healthcheck marking a
   container `unhealthy` does not itself trigger a restart (the infra-gap finding still stands
   for THIS specific sub-mode). Possibly caused by litestream, mid-leak, holding a SQLite file
   lock at the moment memory pressure or a retry stalls it, blocking the app's synchronous
   better-sqlite3 calls without actually dying.

**Correction to the "no auto-recovery" infra-gap finding above**: auto-recovery DOES exist and
DOES work correctly for outright process death (`restart: unless-stopped` is doing its job for
failure mode 1). The gap is narrower than originally stated — it applies specifically to
failure mode 2 (alive-but-unresponsive), not to crashes in general.

**Deliberately NOT attempting a fix to litestream's replica/generation state tonight** — this is
backup-replication state; a wrong manual edit risks corrupting backup continuity, which is a
hard-to-reverse mistake far worse than the current (still-functioning, per replica-sync evidence)
situation. This needs either a litestream upgrade past whatever version fixed this retry-leak (if
it's a known upstream bug — worth checking litestream's GitHub issues for 0.5.12 memory leak
reports) or a deliberate, researched reset of the stuck local snapshot/generation, done by someone
with time to verify backup integrity before and after, not as an overnight reactive fix.

**Revised daylight priority order:**
1. Check litestream's GitHub issues/changelog for a known memory-leak-on-failed-compaction-retry
   bug around 0.5.12; upgrade if a fix exists (verify carefully — 0.5.14 was previously rolled
   back for an unrelated tcp_mem exhaustion bug, so re-test thoroughly before trusting a newer
   version in this environment).
2. If no known upstream fix: research how to safely reset litestream's stuck replica
   generation/snapshot for this specific database without a restore (a full restore risks data
   loss if done carelessly) — likely `litestream generations`/`litestream snapshot` inspection
   first, understand what's actually corrupted before touching anything.
3. Consider raising the container's memory limit as a stopgap (delays time-to-OOM, does not fix
   the leak) if (1) and (2) both need more research time and the shrinking-interval trend
   continues to worsen.
4. The auto-restart-on-unhealthy watchdog recommendation (failure mode 2) remains valid and
   worth doing regardless of the above, since it addresses a genuinely distinct gap.

## Peer-agent stabilization applied (2026-08-10 ~5:53pm CT, GROK)

GROK independently found the same litestream OOM-kill signature (dmesg exit-137 evidence,
`RestartCount=4` match) while doing fleet ops work and applied a stabilization: raised the
container's memory limit from 4GB to **6GB** and pruned old backups (disk 80% -> 44%/48%).
Verified live: `docker inspect` shows `memlimit=6442450944` (exactly 6GB) and `RestartCount=0`
(container was recreated with the new limit, not merely restarted — this was very likely a
Coolify-level config change + redeploy, not a bare `docker restart`).

Shared my mechanism hypothesis (the stuck compaction-anchor retry-leak theory) with GROK via
Slack before they closed out, flagging that a restart/limit-raise treats the SYMPTOM (delays
time-to-OOM) rather than the underlying leak — worth checking litestream's generation/snapshot
state for the specific stuck txid (`2324d`) separately if the leak continues at the new,
higher ceiling. This is a legitimate and valuable interim mitigation regardless: it durably
buys significant runway (a 50% larger ceiling against a leak that took 20-55 min to fill 4GB)
and directly addresses the failure-mode-1 (crash-and-recover) OOM cycle documented above. It does
NOT address failure-mode-2 (hang-without-crash, the WAL-lock-contention finding) or the root
leak itself — both remain open for the daylight investigation per the priority order above.

**Updated state for next session:** memory ceiling 6GB (was 4GB), disk headroom restored,
`RestartCount` reset to 0 (any future kills will show as a small count again, not the misleading
cumulative-4 from tonight). Watch whether litestream's RSS still grows unbounded toward the new
6GB ceiling over the coming hours — if it does, the leak is confirmed unfixed and will eventually
recur (just less frequently); if RSS plateaus, that would be a surprising and useful data point
suggesting the leak was somehow bounded by something other than pure accumulation.

## Correction (2026-08-11 ~2:40am CT) — GROK's fix took longer to fully stabilize than first reported

Earlier optimistic reads tonight ("zero OOM kills since the fix," "2 hours healthy") were based on
short dmesg windows that didn't capture the full picture. Full `journalctl` timeline of litestream
OOM kills since GROK's ~6:53pm CT memory-limit change: **20:26, 21:18, 21:49, 22:09, 22:47 UTC**
(pre-fix, on the old 4GB limit) **then 23:05, 23:30, 23:47 UTC** (still occurring for ~an hour
AFTER the fix landed — likely a container that hadn't yet picked up the corrected limit, or the
already-in-progress leak crossing the new threshold before a fresh process could benefit from it).

**Zero kills logged since 23:47 UTC — an 8-hour clean stretch as of this correction**, spanning
several container recreations from this session's own subsequent deploys (docs, iOS copy fix,
server-metrics fix), all of which inherited the corrected 6GB limit and none of which have been
killed. This is the strongest evidence yet that the higher ceiling is providing real, multi-hour
stability — but 8 hours clean is not the same claim as "fixed"; the leak's underlying cause
(hypothesized: the stuck B2 compaction-anchor retry loop) has not been confirmed resolved, only
given enough headroom that it hasn't recurred yet in this window. Continue monitoring; do not
treat this as closed.

## Correction #2 (2026-08-11 ~4:05am CT) — leak resumed within minutes of the "8h clean" note; peak severity STILL growing

The previous "8-hour clean stretch, real progress" note was accurate when written but stale
almost immediately: a 9th litestream OOM kill occurred at **09:03:08 UTC**, RSS **4.82GB** — a
new all-time peak (prior max was 3.16GB). This directly disproves the framing that the leak had
stabilized; it is continuing, and its PEAK severity is still climbing even under the raised 6GB
ceiling, not just recurring at the old rate with more headroom. At the current growth trajectory
(2.05 → 2.54 → 2.79 → 2.73 → 3.14 → [gap] → 4.82 GB across kills), the ceiling-raise mitigation
has a **finite remaining lifespan** — if peak RSS keeps growing, it will eventually exceed 6GB
too and crash-looping will resume on a similar cadence to before, just delayed by however long
this round bought.

**Site health was unaffected by this kill** — `docker`'s `restart: unless-stopped` handled it
within seconds (0.29s response immediately after), consistent with failure-mode-1 throughout the
night. This is not an operational emergency right now. It IS confirmation that **the underlying
leak remains completely unfixed** — raising the memory ceiling was correctly characterized
earlier as delaying, not solving, and that characterization has now been proven correct by
direct additional evidence rather than left as a hypothesis.

**Do not report this as "resolved" or "stable" in any future summary without re-checking
`journalctl` for kills in the intervening window first** — this session's own optimism outpaced
the evidence twice in one night (the first "2 hours healthy" claim and the "8 hours clean" claim
both turned out to be point-in-time snapshots that a subsequent check immediately falsified).
The only claim that has held up under repeated re-verification: site-serving health itself has
stayed good throughout, because the crash-and-auto-recover path works. The leak itself has never
stopped.

## Root cause CONFIRMED (2026-08-11 ~4:30am CT) — stuck B2 compaction anchor at txid `2324d`, growing multipart upload per retry

The prior sections hypothesized "a stuck B2 compaction-anchor retry loop" from circumstantial
timing evidence only. Direct log evidence from the container that landed the Correction #2 note
above (started 09:17:36 UTC, i.e. the normal post-merge redeploy, not an OOM restart) confirms
it precisely:

```
09:20:00Z ERROR compaction failed ... upload to trading-live/app.db/0001/000000000002324d-000000000002af9d.ltx ... file checksum mismatch
09:21:46Z ERROR compaction failed ... upload to trading-live/app.db/0001/000000000002324d-000000000002afdb.ltx ... file checksum mismatch
09:23:34Z ERROR compaction failed ... upload to trading-live/app.db/0001/000000000002324d-000000000002affa.ltx ... file checksum mismatch
09:25:37Z ERROR compaction failed ... upload to trading-live/app.db/0001/000000000002324d-000000000002b001.ltx ... file checksum mismatch
```

The **starting txid is pinned at `000000000002324d`** across every retry while the **ending
txid keeps advancing** (`af9d` → `afdb` → `affa` → `b001`) roughly every 100-115s. This is the
stuck-anchor mechanism exactly as hypothesized: litestream's level-1 compactor cannot advance
past `2324d` (the B2 multipart upload's final `close` step fails a checksum check every time),
so it retries the *entire accumulated range since that anchor* on each attempt — and because the
anchor never moves, that range grows every cycle, making each retry's multipart buffer bigger
than the last. This explains both open questions from earlier tonight: why memory keeps climbing
at all (unbounded retry of a growing range) and why peak severity climbs kill-over-kill (each
kill starts a fresh process, but the anchor `2324d` persists in the replica state, so the new
process picks up the same stuck point immediately rather than starting clean).

`docker top` on that same container, 8 minutes after start: `litestream replicate` RSS
**4.28GB** of a 4.78GB container total (the `next-server` child was only 313MB) — confirming
litestream itself, not the app, is what's consuming memory, and confirming it happens within
single-digit minutes of a cold start now, not hours. However, memory is **not monotonic
minute-to-minute** — a follow-up reading 70s later showed total container memory at 3.658GB
(down from 4.78GB), consistent with a sawtooth pattern (each failed multipart attempt's buffer
is at least partially reclaimed before the next retry allocates a new, larger one) rather than a
smooth ramp. Don't over-read a single high sample as "about to OOM imminently" — but don't read a
single lower sample as "recovering" either; judge this by the peak-per-kill trend across
`journalctl`, not by spot-checking `docker stats`.

**No existing kill-switch applies here.** `scripts/coolify-prod-start.sh`'s only replication
kill-switch (`R2_USAGE_DISABLE_MARKER`, exit code 41) is explicitly scoped to Cloudflare R2
free-tier quota protection and deliberately *ignores itself* when the configured replica
endpoint is Backblaze B2 (see the script's own comment: "once `AWS_S3_ENDPOINT` is Backblaze B2
... ignore the marker so B2/other backup continues"), which is the case here. There is currently
no generic "disable litestream replication" flag wired into the boot script at all — grepped for
`LITESTREAM_ENABLED`/`SKIP_LITESTREAM`/similar, none exist. Stopping this reactively would
require either a code change (add a generic disable flag) or a manual on-box intervention
(stop/rename the litestream binary invocation), not a config toggle. Deliberately NOT doing
either unilaterally tonight — this is exactly the class of decision the priority order above
reserves for daylight investigation, and the site itself remains healthy throughout via the
existing crash-and-recover path.

**Next steps this unlocks for daylight investigation** (updates the priority order above, does
not replace it): (1) inspect the B2 bucket `trading-live/app.db/0001/` directly for the LTX file
at generation matching `2324d` — the checksum mismatch is on litestream's own upload integrity
check, which usually means either a partial/corrupted prior object at that key blocking a clean
overwrite, or a genuine data race between two litestream processes (a killed-and-restarted one
briefly overlapping its predecessor) writing the same key; (2) check whether manually deleting or
resetting the specific stuck generation via `litestream generations`/`litestream snapshots` (or,
if unavoidable, a controlled `-no-expand-env restore` to a fresh generation) clears the anchor
without a full backup discontinuity; (3) only after that's tried, consider adding a proper
generic litestream-disable boot flag as a safety valve for next time, independent of the
B2-specific fix.

## Escalation (2026-08-11 ~9:40am CT) — kill cadence is measurably ACCELERATING, not just recurring at a steady rate

Full `journalctl` timeline of every OOM kill since the root-cause-confirmation deploy above
(all `exitCode=137`, all auto-recovered by Docker within ~1s, all confirmed by an immediate
follow-up `200` on `/api/health`):

| kill | UTC time | gap since prior kill |
|---|---|---|
| 1 | 11:02:32 | (fresh deploy) |
| 2 | 11:53:56 | 51 min |
| 3 | 13:11:31 | 78 min |
| 4 | 14:00:36 | 49 min |
| 5 | 14:20:28 | 20 min |
| 6 | 14:39:07 | 19 min |

The gap has compressed from ~50-80 minutes down to ~20 minutes over the last three cycles. This
is consistent with — and further supports — the confirmed root cause above: the stuck compaction
anchor (`2324d`) is **not** container-local state that resets on restart; it persists in the B2
replica's own generation/snapshot bookkeeping, so every new container process picks up the exact
same stuck point immediately rather than starting clean. That means the un-compacted WAL range
litestream is futilely retrying keeps growing **across the whole incident**, not just within a
single container's uptime — so each successive kill needs less new WAL growth to hit the memory
ceiling than the last, which is exactly the shrinking-gap pattern observed here.

**This does not change the operational assessment (site health has stayed good through every one
of these six kills, each recovering in ~1s), but it does change the urgency of the daylight fix**:
left unaddressed, this trend — if it continues — points toward the gap eventually compressing to
a genuine crash-loop (kills faster than the ~15-30s a fresh container needs to become healthy
again), which would be materially different from tonight's "brief blip, unaffected" pattern.
Continue monitoring the gap trend specifically, not just kill/no-kill, and treat a gap under
~10 minutes as the trigger to stop deferring this to "daylight" and escalate to an active fix
(most likely: clear the stuck B2 generation per next-step (2) above) regardless of local time.

## Fix executed (2026-08-12 ~12:08am CT) — litestream reset run in production; leak appears resolved, monitoring continues

The escalation trigger fired for real: kill gaps compressed to 5m35s then 12min (23:30:50 and
23:36:26 CT), crossing the ~10-minute threshold set above. Owner approved proceeding.

**What was done**, with the owner's explicit go-ahead:
1. `docker stop -t 30` on the running ST container — clean graceful exit within the timeout, no
   force-kill needed.
2. Since the app's data volume is a named Docker volume with a real host path
   (`/var/lib/docker/volumes/<ST_COOLIFY_APP_UUID>-prod-app-data/_data`), `litestream reset`'s
   documented effect (delete local LTX metadata files, forcing a fresh snapshot on next sync —
   never touches the database file or anything already in B2) was achieved directly via
   `rm -rf .app.db-litestream/ltx` on that host path, rather than spinning up a temporary
   container to invoke the binary. Before deleting: 500 files, 88MB (much smaller than the
   43,130-files/5.9GB found ~8 hours earlier in this same investigation — this container had
   already restarted several times since then, so some local backlog had been cycling, but the
   underlying stuck-anchor problem persisted regardless of container restarts since the anchor
   lives in the B2 replica's own state, not local state — see the root-cause section above).
3. Coolify `start` (not `restart` — reuses the existing built image, no rebuild) brought the
   container back up. Total outage for this step: ~6 minutes (00:08:03-00:09:14 CT), most of
   which was the deliberate 30s graceful-stop wait plus Coolify's own container-swap sequencing.

**Result, ~5 minutes post-restart:**
- Litestream started cleanly — all four compaction-level monitors (1/2/3/9) initialized with zero
  errors in the logs, no `checksum mismatch` on the first several sync cycles (previously this
  error appeared within 2-3 minutes of every fresh container start, without exception, all night).
- Memory: **374MiB (6.09% of the 6GB ceiling)** ~4 minutes after start. Every previous fresh
  start this session had climbed into the multi-GB range by this point (the very first
  root-cause-confirmation container hit 4.28GB of RSS in litestream alone within 8 minutes).
- `litestream status` reports `ok` with a fresh, advancing local txid.

**This is a strong early signal, not a confirmed fix.** Consistent with the standing rule from
the correction sections above ("do not report this as resolved or stable without re-checking"),
this section will be updated (not silently left as the last word) once enough real elapsed time
has passed to say with confidence whether the stuck-anchor pattern is genuinely gone or whether
it recurs — the fastest a problem showed up in any of tonight's fresh-start observations was
under 10 minutes, so several hours of clean operation, spanning at least one level-9 daily
snapshot cycle, would be the meaningful bar for "actually fixed." If it recurs, the next
escalation step is inspecting the B2 bucket directly for the object at the (still unconfirmed)
root cause of the checksum mismatch itself, which this action did not address — clearing local
state unblocks litestream to build a *new* clean generation from scratch; it does not explain
*why* the old generation's uploads were failing integrity checks in the first place.
