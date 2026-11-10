# 2026-07-19 — litestream socket-leak mitigation (sync-interval throttle + region fix)

## Summary

Production deploys were wedged for hours: every Coolify deploy died at `git clone` with
`curl 18 transfer closed / fetch-pack: unexpected disconnect / fatal: early EOF`. Root cause
**proven by live measurement on the box**: litestream leaks ESTABLISHED sockets to the
Cloudflare R2 replica endpoint, exhausting kernel TCP memory, which clamps every connection's
receive window so bulk transfers to high-RTT hosts collapse. Full incident narrative and the
ruled-out alternatives are in `docs/rollouts/2026-07-19-deploy-wedge-diagnosis.md`.

## The measured leak signature

Every leaked fd is a socket to R2 (`172.64.0.0/13:443`), and they share one fingerprint:

- **100% `ESTABLISHED`** (822/822, later 1215/1215), timer `02` = `TCP_TIMER_KEEPOPEN`.
  Zero `CLOSE_WAIT`, zero `SYN_SENT`, zero orphans.
- **~80% carry a non-zero, FROZEN `Recv-Q`** (~34KB each). Two snapshots 45s apart joined by
  inode: of 2,707 surviving sockets, **2,704 unchanged, 0 shrank, 3 closed, 203 new**.
- **`bytes_sent: 2516` byte-identical on every socket**, `data_segs_out: 4`, `lastsnd`/`lastrcv`
  ~60s — one request per connection, response fully received, then abandoned forever.
- Only litestream leaks; the Next.js process sits flat at **30 fds**.
- Fires on **no-op ticks** (41 `ltx file uploaded` events vs ~2,700 leaked connections in
  10 minutes), so the rate tracks `sync-interval`, not write volume.

**Mechanism:** litestream's S3/R2 client opens a new TCP+TLS connection per request and
abandons the HTTP response without draining or closing it. The connection never returns to Go's
idle pool, is never closed by either side, and sits keepalive-pinned with its response bytes
stuck in the kernel receive queue.

## What this change does

1. **`sync-interval: 10s`** on the Coolify replica (previously unset → litestream's **1s**
   default). Leak rate is directly proportional to request rate: ~15k sockets/hr → ~1.5k/hr,
   moving time-to-TCP-pressure from ~5h to ~50h.
   **TRADEOFF: replica RPO 1s → 10s.** On catastrophic host loss, up to 10s of writes would be
   missing from the R2 replica instead of 1s (the local DB and LTX history are unaffected).
   **This is mitigation, not a fix — the leak still exists.**
2. **`region: auto`** (literal) in both `litestream.coolify.yml` and `litestream.yml`. The prior
   `${LITESTREAM_S3_REGION:-auto}` used bash default-expansion; litestream does its own `${VAR}`
   substitution and does **not** support `:-`, so it was resolving to an **empty** region —
   confirmed by the startup banner printing `region=""`. Latent misconfig, unrelated to the
   leak, fixed on its own merits.

## What this change deliberately does NOT do

The **code-level cause is still unproven**, and the leading hypothesis needs a test that
requires a container restart (an owner-chosen window), so no code fix is attempted here:

- **H-A (leading): HTTP/2 + GOAWAY retention.** litestream sets `ForceAttemptHTTP2: true` with
  no `ReadIdleTimeout`/`PingTimeout`; Go retains a `ClientConn` until all streams finish, and a
  stream whose body is never drained never finishes.
- **H-B:** un-drained bodies in litestream's own S3 read paths (upstream #1308). Weak: that's an
  error path, but this leak is systematic every tick.
- **H-C:** per-request client construction. Weakest, no code evidence.

**Discriminating test:** set `GODEBUG=http2client=0` on the container and re-measure fd growth
for 5 minutes — at ~4/sec the answer is unambiguous within 60 seconds. If the leak stops, the
durable fix is that one env var.

## Disproves the 2026-07-10 "durable fix"

`docs/rollouts/2026-07-10-deploy-blocker-tcpmem-litestream.md` blamed litestream **0.5.14** and
pinned back to **0.5.12** as the durable remedy. **That pin is running and it leaks anyway.**
The `Init()` HTTP-Transport block in `s3/replica_client.go` is **byte-identical across
v0.5.11 / v0.5.12 / v0.5.14** — only the retryer changed, never the connection-pool shape — and
**0.5.14 is HEAD**, so there is nothing newer to bump to. Version is a dead axis in both
directions. That note's own soak was recorded "Inconclusive-clean"; the pin was circumstantial.
**Do not re-apply version-pinning as the remedy.**

## Upstream correction owed

`benbjohnson/litestream` issue **#1354** (filed from this project on 2026-07-10) blames PRs
#1305 / #1326, both **0.5.14-only**. We leak on 0.5.12, which contains neither — the issue's
premise is falsified and should be updated with the socket-state evidence above.

## Files

- `litestream.coolify.yml` — `sync-interval: 10s`, `region: auto`.
- `litestream.yml` — `region: auto` (Mac lane, same latent misconfig).
- `docs/rollouts/2026-07-19-litestream-socket-leak-mitigation.md` — this note.
- `STATUS.md`, `docs/EFFORT-LOG.md` — ledger rows.

## Verification

Config-only; both files validated as parsing YAML with the intended values
(`region='auto'`, `sync-interval='10s'`). No application code touched, so the repo test suite is
unaffected — CI `verify` still gates the merge. Effectiveness must be confirmed **after deploy**
by watching `/proc/net/sockstat` TCP `mem` growth rate on the box (expect ~10x slower); a
watchdog alerts at 60% of the `net.ipv4.tcp_mem` ceiling.

## Follow-ups

- Run the `GODEBUG=http2client=0` test in an owner-chosen window; if it confirms H-A, ship the
  env var as the durable fix and open an upstream PR adding `ReadIdleTimeout`/`PingTimeout` and
  `MaxIdleConnsPerHost` to litestream's S3 transport.
- Correct upstream issue #1354.
- Consider a container memory limit so this can never again take the whole box toward OOM.

---

## Stopgap deployed: self-healing watchdog on the prod box (2026-07-20, owner-authorized)

The leak refills to 60% of the `tcp_mem` ceiling every ~1.5-2h, and manual restarts are not a
strategy — especially unattended overnight with markets opening. **Risk being covered:** at
100% of the ceiling the kernel does not merely clamp receive windows (breaking deploys at
git-clone), it can begin refusing TCP allocations outright, which would degrade the trading
app's own outbound broker/market-data calls. That is trading-critical, unlike a blocked deploy.

**Installed on `<HETZNER_OLD_IP_RETIRED>` (NOT in this repo — it lives on the box):**

| Path | Purpose |
|---|---|
| `/usr/local/sbin/litestream-leak-watchdog.sh` | Restarts `socratic-trade-prod` when TCP mem >= **70%** of `net.ipv4.tcp_mem` max |
| `/etc/systemd/system/litestream-leak-watchdog.{service,timer}` | Runs the check every **10 min** |
| `/var/log/litestream-leak-watchdog.log` | One line per skip/restart decision |
| `/root/README-litestream-watchdog.txt` | On-box explanation + uninstall instructions |

Safety properties, all verified by running the real code paths before trusting them:
- **Skips while a Coolify build container is running**, so it can never kill an in-flight deploy
  (regex confirmed to match a real build-container name, and confirmed NOT to match the prod
  container's own name).
- **No-ops below threshold** (verified: exits 0, writes nothing).
- **Restart branch verified** via a logic-only harness with the threshold forced to 1% and the
  `docker restart` swapped for an echo — confirmed it selects the correct container and logs
  both the decision and the post-restart state.

    Status:  systemctl status litestream-leak-watchdog.timer
    Log:     tail /var/log/litestream-leak-watchdog.log
    Disable: systemctl disable --now litestream-leak-watchdog.timer

**This is a stopgap that masks the bug. Remove it once a real fix lands.** It exists so the
box survives unattended, not because repeated restarts are acceptable.

---

## GODEBUG test RESULT (2026-07-20, owner-authorized): H-A ELIMINATED

`GODEBUG=http2client=0` was added to the `socratic-trade-prod` Coolify env and deployed, then
litestream fd growth was measured on the new container.

| | |
|---|---|
| fds | **137 → 1,044 over 4 minutes** |
| implied rate | **~13,600/hr** (baseline ~15,000/hr) |
| litestream error lines in logs | **0** |
| verdict | **leak continues → H-A is WRONG** |

**HTTP/2 GOAWAY retention is NOT the cause.** Forcing the Go HTTP client to HTTP/1.1 changed
nothing meaningful about the leak rate. Usefully, it also caused **zero** replication errors, so
HTTP/1.1 against R2 is safe — it is simply not the fix. The env var was **removed** after the
test (Coolify env `GODEBUG` deleted; it clears on the next deploy).

**Hypothesis space now:**
- ~~H-A: HTTP/2 + GOAWAY retention~~ — **eliminated by direct experiment.**
- **H-B (now leading): un-drained response bodies in litestream's own S3 read paths.**
  `OpenLTXFile` / `OpenSnapshotV3` / `OpenWALSegmentV3` hand raw `out.Body` to callers; upstream
  #1308 documents callers dropping those streams. The earlier objection ("that's an error path,
  but our leak is systematic every tick") is weakened by Lane 1's finding that the replica
  monitor calls `Replica.Sync()` **every second even on an idle DB** (upstream #1210 — the
  `if changed` guard is commented out in `db.go:1048-1052`), so a body dropped on a routine
  no-op path would leak exactly this steadily.
- H-C: per-request client/transport construction — still no code evidence.

**What this means practically:** there is no one-line runtime fix. The remaining candidates are
upstream code defects, so the realistic path is (a) the `sync-interval` throttle in this PR,
(b) the self-healing watchdog already installed, and (c) an upstream issue/PR against litestream
with this evidence. Treat the watchdog as load-bearing for now.
