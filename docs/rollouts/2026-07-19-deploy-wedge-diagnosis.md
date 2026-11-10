# 2026-07-19 — Auto-deploy wedge: root-cause diagnosis (stale GitHub App webhook URL)

## Summary

Production stopped auto-deploying on merge to `main`. Prod sat at `7be71390` while `main`
advanced to `79803667` (pushed 04:54Z) with no deploy firing. Diagnosed to a **stale GitHub
App webhook URL still pointing at the `jays.services` apex**, which stopped reaching Coolify
when the dashboard moved off the apex on 2026-07-09 (`docs/rollouts/2026-07-09-hetzner-8gb-server-migration.md`
and the `AGENTS.md` hosting stanza both record that move; the apex now CNAMEs to the Mac
Cloudflare tunnel).

## Evidence

| Check | Result | Rules out |
|---|---|---|
| Coolify API direct (`GET /api/v1/applications`) | **200 + real data** | "token is dead" |
| App state | `running:healthy`, `last_online_at 2026-07-19 01:42` | app crash / container down |
| Deployment queue | **0 in-flight** (before manual trigger) | zombie deploy blocking the queue |
| Manual deploy via API | **queued + cloning `79803667` successfully** | Coolify build path broken, git creds broken |
| `POST host.jays.services/webhooks/source/github/events/manual` | **200 `pong`** | Coolify webhook receiver down |
| `POST jays.services/webhooks/source/github/events/manual` (apex) | **502** | — **this is the failure** |
| Zone `jays.services` rulesets | no `http_request_firewall_custom` phase present | custom WAF rule blocking GitHub |
| App source config | `source_type: App\Models\GithubApp`, `source_id: 2` | confirms webhook-driven integration |

Both hostnames resolve to the same Cloudflare edge IPs (CF proxies both) but route to
different origins behind it: apex → Mac tunnel (502), `host.` → Coolify (200).

## Root cause (high confidence, one step short of proof)

Coolify builds its GitHub App webhook URL from the instance FQDN at the time the App is
created. The App predates the 2026-07-09 apex move, so its webhook URL is almost certainly
still `https://jays.services/webhooks/source/github/events` — every delivery since that move
has hit a 502 and never reached Coolify. Git *clone* still works because Coolify pulls
outbound (proven by the successful manual deploy), which is a completely separate path from
inbound webhook delivery — which is why the integration looks healthy in every other respect.

**Not proven:** the App's actual configured webhook URL string. Reading it requires
app-owner permissions (`repos/.../installation` → 401 for this token), and Coolify's
`/api/v1` exposes neither `sources` nor per-app deployment history in this version, so the
"last webhook-triggered deploy predates 2026-07-09" correlation could not be run. Everything
else is consistent with this cause and inconsistent with the alternatives above.

## Fix (owner, ~1 minute)

GitHub → Settings → Developer settings → GitHub Apps → the Coolify app → **Webhook URL**:
change the host from `jays.services` to `host.jays.services`, keeping the
`/webhooks/source/github/events` path. Then push any commit to `main` and confirm
`release.sha` on `https://socratictrade.com/api/health` advances.

Verify from the GitHub side via that App's **Advanced → Recent Deliveries** tab — deliveries
since 2026-07-09 should show 502s, which both confirms this diagnosis and shows recovery
after the change.

## Interim state

A manual deploy was triggered via the Coolify API (owner-authorized), deployment
`og4dav7939hm9tc12se1vo94`, targeting `79803667`. Until the webhook URL is corrected,
**merge != live** — every merge needs a manual deploy trigger.

## Corrections to earlier claims made this session

1. **"The Coolify token is dead / needs regenerating" — WRONG.** Direct API calls return 200.
   The MCP server's 401 came from a **stale in-memory token**: `~/apps/mcp-servers/coolify-launch.sh`
   sources `~/.secrets/global-api-keys` at *process start*, and the key was rotated after that
   process launched. Fix is restarting the MCP server, not the credential. Generalizable: an
   MCP 401 while direct curl with the same key succeeds means a stale process, not a bad key.
2. **"Auto-deploy is disabled" — UNFOUNDED.** `is_auto_deploy_enabled` is simply absent from
   this API version's application response (93 keys, none matching); the `None` read was a
   lookup default, not evidence.

## Incident note

While filtering the application record for deploy-related fields, four Coolify
`manual_webhook_secret_*` values (github/gitlab/gitea/bitbucket) were printed into the session
transcript — a name-based field filter that did not anticipate those fields carry live secret
values. **All four should be rotated** in the Coolify UI. Only the GitHub one is plausibly in
use. Lesson: filter secret-bearing records by an explicit allowlist of field names, never by
a topic-keyword match.
