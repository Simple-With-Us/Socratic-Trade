# Deploy — self-hosted (MacBook + Cloudflare Tunnel)

This is the **current** production approach: run the BFF on the Mac, kept alive by a `launchd`
agent, and expose it at **`socratictrade.com`** via a **Cloudflare Tunnel** (no router/port
changes, free TLS at Cloudflare's edge). "Production-ready" here is about the app's operational
properties, not about which machine runs it — see the checklist at the bottom.

> **Naming convention:** `socratictrade.com` = production. Per-app dev/instances use their own
> subdomain (e.g. `claude-dev`, `trading-beta`) → a different local port + tunnel ingress rule, and a
> matching launchd label (`com.jays.<app>-dev`). The app hardcodes no hostname; set `CORS_ORIGIN`.

---

## 1. One-time: configure the app

```bash
cd /path/to/repo
cp .env.example .env
```

Edit `.env` for production:

```ini
HOST=127.0.0.1                 # only cloudflared (same machine) can reach the BFF
PORT=8787
STORE=file                    # durable snapshot at .data/state.json
DATA_DIR=.data
CORS_ORIGIN=https://socratictrade.com
SESSION_SECRET=<paste: openssl rand -hex 32>

# LLM (optional — defaults to the offline mock)
LLM=anthropic
ANTHROPIC_API_KEY=<your key>

# Accounts: Test (local) is always available. Connect Alpaca in the app, or auto-connect here.
ALLOW_LIVE_TRADING=false       # leave false until you deliberately go live
# ALPACA_API_KEY=...           # paper first
# ALPACA_SECRET=...
# ALPACA_MODE=paper

# If you use nvm (so launchd can find node):
# NODE_BIN=/Users/you/.nvm/versions/node/v22.x.x/bin/node
```

Sanity-check it runs in the foreground first:

```bash
node apps/bff/server.mjs      # then open http://127.0.0.1:8787 ; Ctrl-C to stop
node --test tests/*.test.mjs  # optional: 34/34 should pass
```

## 2. Keep it running (launchd)

```bash
bash deploy/install-launchd.sh
# installs ~/Library/LaunchAgents/com.jays.trading.plist (RunAtLoad + KeepAlive)
tail -f deploy/logs/trading.err.log     # watch it boot
```

Manage it:

```bash
launchctl unload ~/Library/LaunchAgents/com.jays.trading.plist   # stop
launchctl load   ~/Library/LaunchAgents/com.jays.trading.plist   # start
```

Keep the Mac awake (so it stays up):

```bash
sudo pmset -a sleep 0 disablesleep 1     # or run under `caffeinate -s`
```

## 3. Expose it via Cloudflare Tunnel

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create trading                     # note the UUID + creds path
cloudflared tunnel route dns trading socratictrade.com
cp deploy/cloudflared.config.example.yml ~/.cloudflared/config.yml
# edit ~/.cloudflared/config.yml: set tunnel UUID, credentials-file, and
#   ingress: socratictrade.com -> http://127.0.0.1:8787
cloudflared tunnel run trading                        # test in foreground
sudo cloudflared service install                      # then run as a background service
```

Open `https://socratictrade.com` — the console should load and `/api/health` should respond.

## 4. Backups (until Postgres)

The whole state lives in `.data/state.json`. Snapshot it on a schedule:

```bash
crontab -e
# */30 * * * * /ABSOLUTE/path/to/repo/deploy/backup-state.sh   # every 30 min, keeps last 30
```

## 5. Updating

**Automatic (recommended):** install the self-updater once — it pulls the deploy branch and
reloads the app on a timer (default every 5 min), so a merge to `gh-pages` lands on
`socratictrade.com` with no manual steps:

```bash
bash deploy/install-autoupdate.sh        # or: bash deploy/install-autoupdate.sh 120   (2 min)
tail -f deploy/logs/autoupdate.err.log   # watch it
# disable: launchctl unload ~/Library/LaunchAgents/com.jays.trading.autoupdate.plist
```

It only reloads when the remote actually moved, skips if you have local edits (non-fast-forward),
and installs no dependencies (zero-dep app). Set `DEPLOY_BRANCH` in `.env` to track a branch other
than `gh-pages`.

**Manual** (if you prefer, or the updater is disabled):

```bash
git pull
launchctl unload ~/Library/LaunchAgents/com.jays.trading.plist
launchctl load   ~/Library/LaunchAgents/com.jays.trading.plist
```

---

## "Production-ready" checklist (host-independent)

Most of this is already built into the app; the rest is operational:

- [x] Secrets server-side only (BFF holds keys; never shipped to the browser)
- [x] HTTPS (Cloudflare edge) + lock `CORS_ORIGIN`; bind `HOST=127.0.0.1`
- [x] Signed sessions; deterministic risk gates; human-confirmed execution; audit log
- [x] Durable persistence (`STORE=file`) + CI (tests + eval + leakage gates)
- [x] Auto-restart / start-at-login (`launchd`)
- [x] Auto-deploy on merge (`deploy/install-autoupdate.sh`)
- [ ] **Backups** scheduled (step 4)
- [ ] **Real login/auth** front door before multi-user — e.g. **Cloudflare Access** in front of `socratictrade.com` (SSO/email gate), in addition to the app's sessions
- [ ] **Postgres** when the file store outgrows itself (Deep Dives 7, 8, 12 specify the schemas)
- [ ] **`ALLOW_LIVE_TRADING=true` only** after deliberate review; connect Alpaca **paper** first

## Future option (not needed now): managed cloud hosting

If/when the Mac being off = unacceptable downtime, or you want 24/7 multi-user independent of your
laptop or git-push-to-deploy, a managed always-on host (e.g. **Render** or **Fly.io**) is the next
step — the same `node apps/bff/server.mjs` + a persistent disk (or Postgres) + the same env vars.
This is intentionally deferred; the Cloudflare-Tunnel + Mac setup above is the current production.
