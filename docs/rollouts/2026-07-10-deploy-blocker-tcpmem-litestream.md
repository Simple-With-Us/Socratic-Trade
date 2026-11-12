# 2026-07-10 — Deploy blocker: kernel tcp_mem exhaustion via litestream 0.5.14 socket churn

## Summary

Every Coolify deployment of `socratic-trade-prod` failed from 08:59Z to 11:52Z
(12 consecutive failures, manual + webhook) at the git-clone step with
`OpenSSL SSL_read: ... unexpected eof while reading`. Production container
stayed healthy but drifted ~15 commits behind `main`.

Root cause was NOT GitHub, TLS, DNS, IPv6, or MTU (all explicitly ruled out on
the box): the kernel hit **TCP memory exhaustion**. `litestream 0.5.14` inside
the prod container (PID running `litestream replicate -exec "npm run start"`)
churns ~20 sockets/s against the R2 replica endpoint (fresh DNS + TLS per
request; retry amplification from the 0.5.14 `ratelimit.None` retryer) and
holds thousands of dead TCP sockets — measured peak **16,840 socket fds on one
PID**, with `sockstat` showing `alloc 16921 mem 183169` pages (~715MB of pinned
receive-queue buffers) against a `tcp_mem` max of `182670` pages. In TCP memory
pressure the kernel clamps every connection's receive window (observed
`rcv_wnd:6144` on an active GitHub transfer), so throughput collapses to
~window/RTT: Cloudflare (2ms RTT) still got ~2MB/s while GitHub (33ms RTT) got
~20KB/s — and GitHub cut the glacial clone mid-transfer, surfacing as "TLS
unexpected eof". `dmesg` had been logging `TCP: out of memory -- consider
tuning tcp_mem` since 02:31Z.

Litestream RSS also grows unboundedly alongside (1.67GB after 6h), so the box
was additionally headed for OOM regardless of tcp_mem.

## Why the symptom looked like a network problem

- Small transfers (git ls-remote, TLS handshakes, pings) all succeeded.
- Only bulk transfers stalled, and stalled worse with higher RTT — classic
  "throughput = clamped-window / RTT" signature, not loss (0% ping loss,
  clean NIC counters, MTU 1500 verified end-to-end with DF probes).

## Fixes applied

1. **Immediate relief (runtime-only, reversible)** — raised the tcp_mem
   ceiling 3x on the box (`sysctl -w net.ipv4.tcp_mem="273945 365343 548010"`,
   original values `91335 121781 182670`). NOT persisted to /etc/sysctl.d; a
   reboot reverts it, or
   `sysctl -w net.ipv4.tcp_mem="91335 121781 182670"` restores originals
   immediately. Keep the raised values until the version pin below is deployed.
2. **Sanctioned catch-up deploy** — triggered Coolify deployment
   `jca2c6wsz7ewydl4q2t4whad`; FINISHED 12:29Z, production now
   `main@ea89b23e`, `/api/health` 200 (db ok, scheduler ticking). Replacing the
   container also released all leaked sockets (TCP mem 715MB -> ~3MB).
3. **Durable fix (this PR)** — pin `LITESTREAM_VERSION` back to `0.5.12` in
   `scripts/coolify-prod-start.sh` and make the cached-binary install
   version-aware (BIN_DIR is on the persistent volume; the old existence-only
   check would have kept serving the cached 0.5.14 forever). A/B evidence
   below. All 0.5.x releases share the LTX replica format; the cutover restore
   already proved cross-version read compatibility.

## Evidence for the version pin (A/B on the box)

- Short scratch replications (tiny DB, fresh replica) showed NO leak on either
  0.5.12 or 0.5.14 — the churn needs prod shape (184MB DB, real churn,
  compaction against accumulated history).
- Prod-shaped soak: two containers on the coolify docker network, each with a
  consistent `sqlite3 .backup` copy of the real app.db, identical synthetic
  write churn (~20KB/s), prod config shape (snapshot block), replicating to
  scratch R2 prefixes (`tmp-fd-leak-test/soak12|soak14`), fd-sampled every
  60s for ~45 min. Result: see the sample log excerpt in this note's
  "Soak results" section (filled in below after completion).
- Live prod observation: the 0.5.14 socket population is a sawtooth (pool
  eviction waves release fds in bulk), but its high-water mark reached the
  tcp_mem ceiling within ~6h of container start and held deploys wedged for
  ~3h continuously.

## Soak results

Inconclusive-clean: both 0.5.12 and 0.5.14 stayed flat (~15 fds) on the
scratch replicas, including through L1 compactions — the leak only reproduces
at prod shape (larger DB and/or weeks of multi-level replica history driving
compaction/retention reads across many remote files). The running prod 0.5.14
process, by contrast, was observed at 2,777 fds / ~186MB TCP mem within ~26
minutes of a fresh container start. The version-pin rationale therefore rests
on: (a) 0.5.12 predates both 0.5.14 S3-transport changes (#1305 relentless
retryer, #1326 ResumableReader reopen); (b) the Mac lane ran 0.5.12-era
litestream cleanly for ~a month against the same replica; (c) post-deploy
verification on the box (fd samples at 0/10/25 min + replication continuity)
is the real A/B — results recorded on the effort board and #ag***-s**c.

Upstream issue filed (scrubbed — no app/infra identifiers):
https://github.com/benbjohnson/litestream/issues/1354

## Timeline addendum

- ~12:57Z: root cause + unblock posted to #ag***-s**c (pipeline already green).
- ~13:10Z: coordinator stand-down (MONET webhook-whitelist report); reconciled
  timelines via the Coolify API — the 08:59-11:52Z failures were
  webhook-delivered deploys dying at the OUTBOUND clone, so the whitelist fix
  addressed a different layer; this branch was parked.
- Later 2026-07-10: owner green-light ("if that is the best fix then do that
  or fix it in best way") — pin landed via this PR. Auto-deploy is live, so
  the merge itself deploys to prod; the deployer (CLAUDE) owns box
  verification: container litestream version = 0.5.12, replication continuity
  (WAL uploads advancing on the R2 replica — HALT + revert if not; backups
  outrank the fd leak), fd/TCP-mem flatness at ~0/10/25 min, /api/health ok,
  restore marker untouched.

## Trade-offs / follow-ups

- 0.5.12 predates two 0.5.14 fixes we care about long-term:
  `fix(retention): retain prior snapshot txid (#1325)` (backup-retention edge
  correctness) and `fix(s3): keep retrying through sustained transport flaps
  (#1305)`. Re-upgrade when upstream resolves
  https://github.com/benbjohnson/litestream/issues/1354.
- The tcp_mem raise is now PERSISTED on the box as cheap headroom insurance
  (`/etc/sysctl.d/99-socratic-tcpmem.conf`, values `273945 365343 548010`,
  comment references this note) — a reboot silently reverting kernel limits
  while any leak-class risk remains is a foot-gun. Delete the file and
  `sysctl --system` (or reboot) to restore distro defaults
  (`91335 121781 182670`) once the leak class is confidently dead
  (0.5.12 fd profile flat over days / upstream fix deployed).
- Scratch R2 prefix `tmp-fd-leak-test/` in the replica bucket holds a few
  hundred MB of test objects — safe to delete any time.
- `/root/fdtest/` on the box holds the test harness (binaries, DB copies,
  logs) — safe to delete after the pin deploys.

## Files

- `scripts/coolify-prod-start.sh` — LITESTREAM_VERSION 0.5.14 -> 0.5.12 +
  version-aware cached-binary reinstall.
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

## Verification

- On the box (root cause): `cat /proc/net/sockstat`, `sysctl net.ipv4.tcp_mem`,
  `dmesg | grep "TCP: out of memory"`, `ss -ti dst <github-ip>` during a
  transfer (rcv_wnd clamp), fd counts via `ls /proc/<litestream-pid>/fd | wc -l`.
- Pipeline unblocked: `git clone` from the box and from a container on the
  coolify network completes in ~1s; Coolify deployment
  `jca2c6wsz7ewydl4q2t4whad` FINISHED; `https://socratictrade.com/api/health`
  200 ok.
- Repo gate for this PR: `npm run lint`, `npx tsc --noEmit`, `npm test`,
  `npm run build` (run before landing via `scripts/land.sh`).
