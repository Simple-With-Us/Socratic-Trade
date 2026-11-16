# Runbook — ST Litestream B2 restore drill (host, scheduled)

## Why

Tier-1 backups are not proven until a full B2 restore succeeds on the production host.
`scripts/litestream-restore-drill.sh` is the manual drill; this timer automates it weekly
off-hours without touching live `app.db` or the replica.

Policy: `docs/backup-policy.md`.  Linear: ST-4622.

## What it does

| Step | Behavior |
| --- | --- |
| Preflight | Requires `INFISICAL_TOKEN_FILE` (mode 0600 service token) plus non-secret config in `/etc/default/st-litestream-restore-drill` (mode 0600).  B2 keys are read from Infisical at run time, not from the env file. |
| Disk | Refuses unless scratch parent has >= 2.2x live DB free space (default parent `/data/scratch`) |
| Drill | Runs `litestream-restore-drill.sh` under `timeout` (default 6h) in an ephemeral scratch dir |
| Status | Writes `/var/lib/st-ops/litestream-restore-drill-status.json`, including a per-run `runId`.  A failed status write is a failed run; a previous `pass:true` is not kept. |
| Alert | One Sentry event on failure when `ST_RESTORE_DRILL_NOTIFY=1` and `SENTRY_FLEET_DSN` is available (from Infisical, unless already in the process environment on a manual run).  SIGTERM/SIGINT also write `pass:false` and notify, then exit 128+N. |

Timer: `st-litestream-restore-drill.timer` — Sunday 04:00 UTC with `RandomizedDelaySec=3600`.

## Credentials (Infisical service token)

The scheduled lane does **not** store `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or
`SENTRY_FLEET_DSN` in the env file.  Under systemd, `EnvironmentFile` is the process
environment and always wins, so leftover keys in that file would otherwise become the
credentials.  The wrapper ignores those keys and reads secrets from Infisical instead.

**Auth:** an Infisical **service token** only.  Do not use a machine identity or universal
auth for this unit.

On the host, after install:

1. Create a mode-0600 token file (suggested path
   `/etc/default/st-litestream-restore-drill.infisical-token`) containing only the service
   token.  Point `INFISICAL_TOKEN_FILE` at that path in the env file.  The file must be
   owned by root (the user the unit runs as); a token file owned by any other uid fails
   the drill with `token_file_invalid` before the token is read.
2. Set `INFISICAL_PROJECT_ID` (always required) in the env file at install time.  Supply
   the id of the Infisical project that holds the B2 secrets; this repo does not ship one,
   and the wrapper always passes it as `--projectId` so the CLI never picks a project on
   its own.
3. Confirm `INFISICAL_DOMAIN` (documented default `https://app.infisical.com`),
   `INFISICAL_ENV` (documented default `prod`), and `INFISICAL_SECRET_PATH` (documented
   default `/`).  Do not assume a subpath already exists.  `INFISICAL_DOMAIN` must be an
   `https://` URL; the wrapper refuses plain HTTP, and its API fallback refuses any
   redirect to another scheme, host, or port so the token is never forwarded.
4. Confirm the secret names in that project/env/path.  Documented defaults, which must
   also be confirmed, are:
   - `AWS_ACCESS_KEY_ID` (override with `INFISICAL_SECRET_AWS_ACCESS_KEY_ID`)
   - `AWS_SECRET_ACCESS_KEY` (override with `INFISICAL_SECRET_AWS_SECRET_ACCESS_KEY`)
   - `SENTRY_FLEET_DSN` (optional; override with `INFISICAL_SECRET_SENTRY_FLEET_DSN`)
5. Keep non-secret B2 config (`AWS_S3_BUCKET_NAME`, `AWS_S3_ENDPOINT`, `AWS_REGION`) in
   the env file.  The env file accepts **bare `KEY=VALUE` lines only** (no `export`, no
   invalid identifiers).  A malformed line fails the drill, writes `pass:false`, and
   alerts when notify is on.

`ST_RESTORE_DRILL_ALLOW_ENV_CREDS=1` is a test/emergency gate that allows process or env-file
credentials.  Do not set it on the scheduled timer.  The wrapper reads the gate once before
it parses the env file, so its position in the file does not matter.  When the gate is not
set, B2 credentials missing from Infisical alert Sentry (`credentials_unavailable`) when a
DSN is available, then write `pass:false`.

## Install (owner on host — agents do not deploy)

From a checkout on the **production restore-drill host**, as root:

```bash
cd /path/to/Socratic-Trade
bash scripts/ops/install-st-litestream-restore-drill.sh
```

The installer writes `/etc/default/st-litestream-restore-drill` from the example if missing
(mode `0600`) and strips leftover secret keys from an existing file without printing
values.  Fill the Infisical settings above.  Never commit secrets.

## Verify after install

systemd does not inherit the invoking shell's environment.  To run one notify-disabled
start **without** patching the persistent env file, use the helper, which writes a
non-persistent runtime drop-in under `/run/systemd/system/` and removes it when it exits
(including on Ctrl-C, SIGHUP or SIGTERM).  If the helper is killed with SIGKILL, or the
host crashes, before it cleans up, the drop-in survives until the next reboot and every
scheduled run until then writes `pass:false` without a Sentry alert.  Recover before the
next Sunday run with `/usr/local/sbin/st-litestream-restore-drill-start-notify-off.sh
--cleanup` (or rerun the helper, or reboot), then confirm with
`systemctl show st-litestream-restore-drill.service -p ExecStart` that
`ST_RESTORE_DRILL_NOTIFY=0` is gone.  The drop-in overrides `ExecStart` with
`/usr/bin/env ST_RESTORE_DRILL_NOTIFY=0` rather than adding `Environment=`, because
systemd lets the `EnvironmentFile=` value (`ST_RESTORE_DRILL_NOTIFY=1`) override
`Environment=`:

```bash
systemctl list-timers st-litestream-restore-drill.timer
/usr/local/sbin/st-litestream-restore-drill-start-notify-off.sh
journalctl -u st-litestream-restore-drill.service -n 50 --no-pager
jq . /var/lib/st-ops/litestream-restore-drill-status.json
```

Equivalent manual steps, if you are not using the helper:

```bash
drop_dir=/run/systemd/system/st-litestream-restore-drill.service.d
mkdir -p "$drop_dir"
printf '[Service]\nExecStart=\nExecStart=/usr/bin/env ST_RESTORE_DRILL_NOTIFY=0 /usr/local/sbin/st-litestream-restore-drill.sh\n' >"$drop_dir/notify-off.conf"
trap 'rm -f "$drop_dir/notify-off.conf"; rmdir "$drop_dir" 2>/dev/null || true; systemctl daemon-reload' EXIT
systemctl daemon-reload
systemctl start st-litestream-restore-drill.service
```

Do not `sed` `ST_RESTORE_DRILL_NOTIFY` in `/etc/default/st-litestream-restore-drill` for
this dry-run.  An interrupted edit can leave weekly failure alerts switched off.

Hermetic selftest (any Linux dev seat):

```bash
bash scripts/ops/st-litestream-restore-drill.selftest.sh
```

## Uninstall

```bash
bash scripts/ops/install-st-litestream-restore-drill.sh --uninstall
```

## Related

- `scripts/litestream-restore-drill.sh` — manual drill (same assertions)
- `scripts/ops/verify-cold-snapshot-restore.mjs` — tier-3 cold archive drill
- `docs/litestream.md` — replication config and history
