# Litestream IPC socket → writable DB path (2026-07-31)

## Context & objective

After the `AWS_*` R2 cutover, litestream **replication** to `socratic-trade-bucket`
was healthy (`replica sync` in container logs), but `/api/health` still reported
`storageDegraded: true` with `litestreamDegradedReasons: ["unavailable"]` and
`litestreamSource: "none"`. Root cause: the Coolify config bound the control
socket at `/var/run/litestream.sock`, which the non-root `node` user cannot
create (`bind: permission denied`). Health only trusts IPC in
`DB_BOOTSTRAP=live` mode, so a dead socket looked like "backups unknown" forever.

## Changes made

- `litestream.coolify.yml`: socket path `/var/run/litestream.sock` →
  `/app/data/litestream.sock` (persistent volume, writable by `node`).
- `src/lib/runtime-health.ts`: `defaultLitestreamSocketPath(dbPath)` colocates
  the IPC socket next to the DB; `getLitestreamRuntimeHealth` uses that default
  (still overridable via `LITESTREAM_SOCKET_PATH` or an explicit option).
- `test/runtime-health.test.ts`: asserts the new default path.

## Decisions & trade-offs

- Prefer a path derived from `dbPath` over a hard-coded `/app/data/...` string in
  the health reader so local/dev DBs also get a writable default.
- Leave Mac `litestream.yml` alone (no socket stanza; host runs as the owner).
- Socket file will appear under `/app/data/` on the volume — small and expected;
  do not treat it as a backup artifact.

## Verification state

```bash
npx vitest run test/runtime-health.test.ts   # 21/21 pass
```

Post-deploy (production):

```bash
curl -s https://socratictrade.com/api/health | jq '.checks.storage | {litestreamState, litestreamSource, litestreamAgeSeconds, litestreamDegradedReasons, litestreamStatus}'
docker logs socratic-app 2>&1 | grep -E 'litestream.sock|replica sync|permission denied' | tail -10
# expect: no "bind: permission denied"; litestreamSource=ipc; degraded reasons empty/absent when sync is fresh
```

## Next steps & blockers

- None for this fix. If health still shows unavailable after deploy, confirm the
  running container config embeds the new yml (`grep path: /app/data/litestream.sock`
  inside the image) and that `/app/data` is the mounted volume.
