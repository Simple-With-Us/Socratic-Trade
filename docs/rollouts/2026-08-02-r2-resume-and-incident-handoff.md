# 2026-08-02 — HANDOFF: R2 replication resumed (quantified go/no-go) + prod-wedge incident state

MONET session, second closeout of the day. Covers everything since the previous handoff
(`docs/rollouts/2026-08-02-monet-session-handoff.md`).

## 1. Context & Objective

Owner instructions, in order: repair/verify what Antigravity took over (done, previous
handoff), explain the R2 >70% alert, and **resume R2 replication if the probability of
exceeding any R2 free-tier limit is under 10%**. In between, production hard-wedged for
~13 minutes after an unrelated deploy — that incident's state is recorded here too.

## 2. R2: what happened, the assessment, and the action taken

### Why it crossed 70%

Litestream uploads snapshots + WAL of the ~1.5 GiB SQLite DB at a measured ~3 GB/day
against a 10 GiB free tier. Retention was 30 DAYS until 2026-08-01 23:29Z; the interim cut
to 7 days (#2334) prunes nothing until snapshots are >7 days old — and the bucket only
started accumulating ~Jul 30 (the AWS_* creds cutover), so nothing qualified. Growth
continued unimpeded and crossed the 70% line, at which point the owner-directed
kill-switch (r2-usage.ts) fired exactly as designed: alert → persistent marker
(`/app/data/.litestream-r2-disabled`) → container restart WITHOUT litestream.

### Measured facts (not estimates)

- Marker (read in-container over SSH): fired **2026-08-02T07:54:47Z**, storage
  **7,559,454,901 bytes = 7.04 GiB = 70.4%**, `alertBasis: absolute`. **Storage was the
  ONLY exceeded metric** — Class A/B never fired, even on the floored-pace basis.
- Replication has been OFF since 07:54Z → zero bucket writes → usage frozen at 7.04 GiB.
- The deployed container carries the **48h retention** config (verified by reading
  `/app/litestream.coolify.yml` in-container — #2338's change, which had been stranded in
  an unmerged PR with a conflict until this session resolved and landed it).

### The <10% assessment

| Limit | Model | Verdict |
|---|---|---|
| Storage 10 GiB | Resume adds one initial snapshot (~0.5–1.5 GiB compressed; transient peak ~8–8.5 GiB), then retention enforcement deletes everything older than 48h (~3 GiB of the Jul 30–31 tranche) → ~5 GiB, climbing to ~6 GiB steady state (48h × 3 GB/day). Breach requires retention enforcement to fail silently for >1 day AND the still-armed 70% kill-switch (which re-fires at 7 GiB, long before 10) to also fail. | ≪ 10% |
| Class A 1M/mo | MTD was under threshold at fire time; prune burst ≈ 20–40k deletes; steady ~8.6k PUTs/day × remaining month ≈ 250k; total ≈ 300k. Pace alert + kill-switch also guard this lane. | ≪ 10% |
| Class B 10M/mo | Reads are restore-only. | ≪ 10% |
| CT / UM buckets | Separate Cloudflare accounts; ST resume does not touch them. CT: host-level `litestream-congress` (72h retention, 277 MB DB). UM: unaffected. | n/a |

Overall ≈ 1–2%, and the failure mode if wrong is **bounded**: the kill-switch re-pauses
replication and notifies — it cannot breach the tier. Criterion met.

### Action taken (~13:2xZ)

Deleted the marker in-container and `docker restart socratic-app` **directly over SSH
(`ubuntu@<ORACLE_IP_RETIRED>`) — deliberately NOT a Coolify restart**, because a Coolify
"restart" rebuilds from main HEAD (it is a deploy), while `docker restart` reuses the
same image. The admin resume route (`POST /api/admin/r2-usage/resume`) does exactly this
marker-delete + restart, but is session-admin-gated, which an agent cannot satisfy; the
marker file itself documents the manual path as equivalent. Boot-time one-shot restore is
marker-guarded separately, so a restart with the DB present never re-restores.

### What to watch after resume

- `/api/health` → `storage.litestreamStatus: "replicating"` (a watch was running at
  handoff time).
- **Known nuisance risk, not a breach risk:** Cloudflare's storage analytics can lag,
  so the monitor's next check may still read ≥70% and re-fire the kill-switch even
  though the bucket has actually been pruned under 6 GiB. If replication silently pauses
  again with a fresh marker shortly after resume, that is the likely cause — check the
  marker's `mtd` against reality before reacting, and surface to the owner rather than
  fighting the guardrail.
- **Owner decision still open:** 48h PITR history vs ~$1.35/mo paid tier for 30 days.

## 3. Prod wedge incident (~12:01–12:14Z) — recovered, NOT root-caused

- Timeline: healthy on `3bc08106` at 11:18Z → #2353's `6d865b11` live ~11:57Z → ALL
  routes 000 from ~12:01Z (container `running:unhealthy`, app logs showed a clean boot
  with the scheduler active) → Coolify healthcheck restarted the container ~12:14Z →
  same code has served normally since. Sunday, market closed, no trading impact.
- Symptom shape (clean boot + scheduler alive + every route connection-dead) points at
  synchronous work holding the event loop or SQLite (better-sqlite3 is sync).
- Suspects CHECKED AND CLEARED by reading the deployed code: the new
  `nextMarketOpenStrictlyAfterMs` loop (bounded at 10 iterations),
  `previousTradingDayStart` (not modified by #2353), the usage-monitor-knobs fetch
  (2.5s abort + refresh guard, fail-open).
- Remaining PRIME SUSPECT, unproven: #2353's new `market-scan-freshness` scheduler lane
  — it deliberately runs a full `scanMarket` on weekends and fires when the newest scan
  is >20h stale, which was exactly true right after boot. Note #2353's own commit message
  labels part of its content "stage 2 PARTIAL — tests NOT run; treat every file as
  unreviewed".
- **Safety lever staged: draft PR #2355** — a clean `git revert 6d865b11`, pushed,
  deliberately NOT armed. If the wedge recurs, the order of levers is:
  1. `MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS=0` (documented off-switch for the suspect
     lane) + restart — zero code loss;
  2. mark #2355 ready + `gh pr merge --squash --auto` — full revert, loses #2353's
     provider hardening until re-landed.
- Root-causing belongs to the #2353 lane when it resumes (its own handoff:
  `docs/rollouts/2026-08-02-data-cascade-freshness-handoff-2.md`).

## 4. Verification State

- Deploy pipeline: repaired earlier today and since proven across 4+ organic
  webhook-triggered deploys (receipts:
  `docs/rollouts/2026-08-02-deploy-webhook-secret-repair.md`).
- R2 resume: marker removal + restart executed; litestream-replicating confirmation was
  in flight at note-writing time (watch running; if this note lands without a correction,
  the watch confirmed it).
- No repo code changed in this stretch; this note + board rows are the only repo delta.

## 5. Next Steps & Blockers

1. Confirm the monitor's next scheduled check shows storage falling (expect ~5–6 GiB
   after the first retention enforcement; the admin card groups per account).
2. Watch for a lag-induced kill-switch re-fire (see §2); if it happens, verify against
   the marker payload before resuming again.
3. #2353 root-cause (its lane) — the freshness lane runs `scanMarket` again whenever the
   newest scan is >20h old, so the wedge window can reopen on any restart until diagnosed.
4. Owner decisions: R2 paid tier vs 48h history; FMP subscription; Massive plan tier;
   hook-secret re-sync in the app-recreate recipe.

## 6. Zero-Code Findings / gotchas recorded

- `~/.ssh/config`'s `Host coolify` alias still points at the DELETED Hetzner box
  (<HETZNER_OLD_IP_RETIRED>) — direct `ssh ubuntu@<ORACLE_IP_RETIRED>` works (host `usagemonitor`).
  Worth fixing the alias.
- This Coolify version has no `/applications/{uuid}/execute` API — in-container work
  goes over SSH + `docker exec`.
- The litestream binary is absent from the container while the kill-switch marker
  exists (the boot script skips the entire litestream path, including fetching the
  binary) — `litestream: not found` in-container is a SYMPTOM of the disabled state,
  not an image defect.
