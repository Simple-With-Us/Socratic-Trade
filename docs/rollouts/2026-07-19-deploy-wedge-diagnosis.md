# 2026-07-19 — Deploy wedge: deploys FAIL at git-clone (mid-transfer disconnect)

## Summary

Production stopped advancing: prod sat at `7be71390` while `main` reached `79803667`
(pushed 04:54Z). **Root cause: deployments are not being skipped — they run and FAIL at the
`clone_repository()` step**, with the git transfer dying mid-stream. This is the same class
of failure as the documented 2026-07-10 incident
(`docs/rollouts/2026-07-10-deploy-blocker-tcpmem-litestream.md`), where bulk transfers
collapsed while small requests kept working.

Two manual deploys were triggered this session (owner-authorized). The first
(`og4dav7939hm9tc12se1vo94`, 22:24:30Z → failed 22:43:03Z) failed with:

```
Cloning into '/artifacts/og4dav7939hm9tc12se1vo94'...
error: RPC failed; curl 18 transfer closed with outstanding read data remaining
error: 2828 bytes of body are still expected
fetch-pack: unexpected disconnect while reading sideband packet
fatal: early EOF
fatal: fetch-pack: invalid index-pack output
=> Command execution failed (exit code 128) ... git clone --depth=1 ...
=> App\Exceptions\DeploymentException at ApplicationDeploymentJob.php(937): clone_repository()
```

Auth is NOT the problem — the clone authenticates and begins transferring, then the
connection drops. A second deploy (`s11ugely6t4n3nxpirh3b3h2`) was triggered to distinguish
transient from systemic.

## Evidence gathered

| Check | Result | Rules out |
|---|---|---|
| Coolify API direct | 200 + data | dead API token |
| App state | `running:healthy` | container down |
| Deployment queue | 0 in-flight before trigger | zombie-deploy queue block |
| Deploy execution | **FAILS at clone, exit 128** | "webhook never fired" as the whole story |
| `watch_paths` | `None` | path-filter suppressing deploys |
| `git_branch` | `main` | wrong-branch config |
| Webhook endpoint `host.jays.services` | 200 `pong` | Coolify receiver down |
| Zone `jays.services` rulesets | no custom firewall phase | Cloudflare WAF block |
| `LITESTREAM_VERSION` in `scripts/coolify-prod-start.sh` | **`0.5.12`** (pin held) | recurrence of the 0.5.14 socket leak |
| Server record | **`unreachable_count: 6`**, `is_reachable: true` now | a totally stable box |
| Server disk | `high_disk_usage_notification_sent: false` (threshold 75%) | disk-full |

## Why this looks like the 2026-07-10 tcp_mem failure

That incident's signature: *small transfers fine, bulk transfers stall and get cut, container
stays healthy, both manual and webhook deploys fail at clone.* All four hold here. The
mechanism there was kernel TCP memory exhaustion clamping receive windows, so high-RTT bulk
transfers (GitHub, 33ms) collapsed while low-RTT ones (Cloudflare, 2ms) still worked.

**Crucially, that incident's relief was explicitly runtime-only:** `sysctl -w
net.ipv4.tcp_mem="273945 365343 548010"`, with the note *"NOT persisted to /etc/sysctl.d; a
reboot reverts it."* The durable half of that fix (the litestream 0.5.12 pin) IS in place and
verified above — so this is not the 0.5.14 leak returning. But if the box has rebooted since
2026-07-10, the raised ceiling is gone, leaving the kernel back at the defaults that failed.

## Not proven (be honest about the gap)

Confirming tcp_mem exhaustion requires reading `sysctl net.ipv4.tcp_mem` and
`/proc/net/sockstat` **on the box**, which needs SSH access this session does not have.
The Hetzner MCP is also currently broken in this environment (missing certifi CA bundle path,
likely a casualty of a uv-cache cleanup), so server-side metrics were unavailable too. The
alternative explanation — plain transient network trouble between Hetzner and GitHub — is not
excluded; `unreachable_count: 6` is consistent with either.

## Recommended fix (needs box SSH)

```bash
ssh root@135.181.192.190
sysctl net.ipv4.tcp_mem                 # defaults are "91335 121781 182670"
cat /proc/net/sockstat                  # look at TCP: alloc / mem vs the tcp_mem max
# if mem is at/near the ceiling:
sysctl -w net.ipv4.tcp_mem="273945 365343 548010"
# then re-trigger a deploy and confirm release.sha advances
```

**Improvement over last time:** persist it so a reboot cannot silently re-wedge deploys —
write the value into `/etc/sysctl.d/99-tcp-mem.conf`. The 2026-07-10 note deliberately left it
runtime-only pending the litestream pin; that pin has since landed and held, so persisting is
now the safer default.

Also worth checking while on the box: `docker ps` for the `cloudflared-...` service, which
Coolify reports as `exited`.

## Interim state

**Merge != live.** Auto-deploy may or may not be firing — it is moot while every deploy fails
at clone. The six open PRs can merge but will not reach production until this is fixed.

## Corrections to earlier claims made this session

1. **"The Coolify token is dead / needs regenerating" — WRONG.** Direct API returns 200. The
   MCP's 401 came from a **stale in-memory token**: `~/apps/mcp-servers/coolify-launch.sh`
   sources `~/.secrets/global-api-keys` at *process start*, and the key was rotated after that
   process launched. Fix is restarting the MCP server. Generalizable: an MCP 401 while direct
   curl with the same key succeeds means a stale process, not a bad credential.
2. **"Auto-deploy is disabled" — UNFOUNDED.** `is_auto_deploy_enabled` is simply absent from
   this Coolify API version's application response (93 keys, verified on both the list and
   detail endpoints); the `None` read was a lookup default, not evidence.
3. **"Stale GitHub App webhook URL pointing at the apex" — WRONG.** Owner confirmed the
   webhook URLs were already `host.jays.services`. The apex returning 502 is real but
   irrelevant — nothing is configured to use it. This diagnosis was built on a plausible
   correlation without confirming the actual configured value, and it collapsed the moment
   the owner checked. The deploy-failure evidence above supersedes it entirely.

## Incident note

While filtering the application record for deploy-related fields, four Coolify
`manual_webhook_secret_*` values (github/gitlab/gitea/bitbucket) were printed into the session
transcript — a name-based field filter that did not anticipate those fields carry live secret
values. **All four should be rotated** in the Coolify UI; only the GitHub one is plausibly in
use. Lesson: filter secret-bearing records by an explicit allowlist of field names, never by
topic-keyword match.
