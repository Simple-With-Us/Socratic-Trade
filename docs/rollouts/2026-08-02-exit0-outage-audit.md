# 2026-08-02 — Exit-0 outage: audit, root cause, and hardening (MONET)

Branch `monet/exit0-outage-audit` (throwaway worktree off `origin/main`; the standing
`trading-monet` lane held unpushed slice-3 work and was left untouched).

## 1. Context & Objective

Production container `socratic-app` "exited cleanly (code 0)" at 2026-08-02 15:29:14Z on
release `23973a80`, with no stop/kill visible in `docker events`, and stayed down until
manually started at 15:32:24Z. Tasks: (1) audit every `process.exit`/`exitImpl` path
reachable in production and eliminate exit-0 paths; (2) evaluate flipping the restart
policy so clean exits also restart, versus the R2 kill-switch's exit-41 design;
(3) verify the `docker events` forensics method.

## 2. Root cause (established with on-box receipts, not inference)

**The container did not exit spontaneously. It was stopped via the docker API, and the
"clean exit 0" was fabricated by a pid-1 signal-handling bug in our own wrapper chain.**

Receipts, in order:

1. `journalctl -u docker.service` at 15:29:14Z (durable, unlike `docker events`):
   `ShouldRestart failed, container will not be restarted ... error="restart canceled"
   execDuration=19m22s exitStatus="{0 2026-08-02 15:29:14}" hasBeenManuallyStopped=true`.
   Docker refused the restart **because a stop had been requested through its API** — not
   because of the exit code.
2. The restart policy is `unless-stopped` (docker inspect), **not** on-failure as the
   task premise assumed. `unless-stopped` restarts ANY spontaneous exit — including 0 —
   and only honors API stops. A genuinely spontaneous exit 0 would have been restarted.
3. **Sandbox repro of the exit-0 fabrication** (ran the exact production process chain —
   `node infisical-run` → `node infisical-app-child` → `npm run` → `sh` → leaf server —
   inside the real `socratic-app` image on the box, then `docker stop`):
   - in-container npm (11.11.0) **died from the raw SIGTERM without forwarding it** — the
     leaf server never received the signal (its SIGTERM→exit-143 handler never fired);
   - both infisical wrappers handled "child died by signal" with the classic re-raise
     `process.kill(process.pid, signal)` — but the outer wrapper is **container pid 1**,
     and the kernel ignores default-disposition signals for pid 1, so the re-raise
     silently no-opped, the event loop drained, and node exited **0** naturally;
   - observed container exit code: **0**, `stop took 0s` — identical to the incident.
   Side finding: because npm swallows the signal, every deploy/stop was **hard-killing**
   next-server (no graceful shutdown, orphans SIGKILLed at teardown).
4. Same-day precedent for the stop itself: the R2-resume session's handoff note records
   direct-SSH `docker restart socratic-app` as an established ops pattern that day, and
   sshd shows owner-Mac one-off sessions at 15:21/15:25Z plus a Coolify-internal root
   session from 15:24:41Z. Coolify's `activity_log` recorded nothing in the window and
   the deployment queue shows nothing after the 14:44 deploy (finished ~15:11 — it
   created this container at 15:08:23 and stopped its predecessor at 15:11:23, both
   normal). **Exact actor unattributed**; the class is certain: an on-box docker-API stop
   with no paired start. Two earlier same-day stops (14:36:36, 15:11:23) recorded the
   same bogus exit 0 — this bug had been corrupting every stop's exit code.

## 3. Audit: every process.exit / exitImpl reachable in production

- `src/lib/r2-usage.ts` — `exitImpl(41)` (kill-switch) and `exitImpl(42)` (resume). Both
  deliberate, non-zero, restart-dependent; both restart correctly under `unless-stopped`
  because they are spontaneous exits. **Unchanged.**
- `src/lib/rag/sec-ingest-worker.ts`, `src/lib/durable-state.ts`, `src/lib/scheduler.ts`
  — signal/beforeExit listeners only; none call `process.exit`. **Clean.**
- `scripts/*.ts|mjs` CLI exits (reindex-all, eval/*, benchmarks, provider-knob-diff,
  codex-dev-server, infisical-bootstrap-env): standalone processes, **not importable from
  server code** (verified: no `src/` import reaches `scripts/`). Irrelevant to the
  container's lifetime.
- `scripts/infisical-run.mjs` / `scripts/infisical-app-child.mjs` — `managedChild`'s
  signal re-raise was the **exit-0 fabricator** (see §2). **Fixed.**
- `scripts/coolify-prod-start.sh` — three `exec` branches, no exit-code handling at all.
  **Fixed** (supervisor).
- Next 16.2.12 itself exits 130/143 on SIGINT/SIGTERM (verified in
  `node_modules/next/dist/server/lib/start-server.js`) — the older "Next exits 0 on
  SIGTERM" behavior is gone. Node-drain exit-0 is impossible while the HTTP listener is
  live.
- PRs #2353/#2354/#2356/#2360: diffs contain no `process.exit`/signal-handling changes.

Conclusion: **no app-level exit(0) path existed**; the fabricated 0 came from the wrapper
chain, and only on API stops.

## 4. Changes made

- `scripts/infisical-run.mjs`, `scripts/infisical-app-child.mjs`: child-died-by-signal now
  exits `128 + N` with a logged reason instead of the pid-1-broken self-re-raise.
- `scripts/coolify-prod-start.sh`: all three launch branches now run under a `run_app`
  supervisor that (a) forwards SIGTERM/SIGINT to the app, (b) logs every exit with its
  code and whether a stop signal was forwarded, (c) re-tags a **spontaneous** clean exit
  to **40** (a stop-signal-preceded exit propagates unchanged). The app is invoked as
  `node_modules/.bin/next start` directly — `npm run start` is banned from the container
  exec chain (signal black hole; restores graceful shutdown on deploys/stops).
- `src/lib/exit-guard.ts` (new) + `instrumentation.ts` wiring: production-gated guard
  that logs every `process.exit()` with code + call-site stack, logs stop-signal receipt,
  re-tags a spontaneous in-app `process.exit(0)` to **43**, and self-handles stop signals
  if it is ever the only registered handler (exit 128+N, never unkillable).
- `test/exit-guard.test.ts` (new): 9 dependency-injected tests (activation gating,
  re-tag, signal pass-through, 41 pass-through, lone-handler fallback, idempotence,
  drain warning).
- `AGENTS.md`: "Production exit-code contract" stanza — the invariant, the exit-code map
  (40/41/42/43/130/143), the three traps (pid-1 re-raise, npm-in-exec-chain,
  docker-events forensics), and "if you stop the prod container, you own starting it".

Verification of behavior (box, real image, fixed chain): `docker stop` → exit **143**
with the leaf actually receiving SIGTERM; spontaneous leaf exit 0 → supervisor FATAL log,
exit 40, docker auto-restarts under `unless-stopped`. The extracted `run_app` function
text was also unit-tested locally (0→40, 7→7, forwarded-TERM→143).

## 5. Task 2 — restart-policy evaluation: NO flip needed

- Actual policy is already `unless-stopped` (task premise of "does not restart clean
  exits" was wrong — it restarts any spontaneous exit regardless of code, survives
  daemon restarts/box reboots, and honors manual stops).
- The kill-switch's exit-41-then-boot-without-litestream design does not depend on the
  code being non-zero under this policy; it depends on the exit being spontaneous. It
  keeps working unchanged, and would even under `always`.
- Flipping to `always` would auto-revive API-stopped containers on daemon restart — that
  would fight Coolify's own stop/deploy semantics for near-zero gain. **Recommendation:
  keep `unless-stopped`.** The real protections are (a) honest exit codes (this PR) and
  (b) the documented rule that any manual stop must be paired with a start.

## 6. Task 3 — docker events forensics method: verified broken, replacement documented

- The daemon keeps events only in an in-memory ring (~256 entries; measured on the box:
  247 retained events reaching back only ~9 minutes, because Coolify healthchecks emit
  exec_* events every few seconds). A `--since/--until` window older than the ring
  returns empty **silently** — "no die/stop event in a 45m window" was an artifact, not
  evidence. The ring also empties on daemon restart.
- Durable replacements (all used above): `journalctl -u docker.service` (logs every
  non-restart decision with `hasBeenManuallyStopped` and true exit status),
  `journalctl -u containerd.service` (shim lifecycle), `docker inspect`
  (State/RestartPolicy), `docker logs <container>` (survives restarts of the same
  container).

## 7. Decisions & Trade-offs

- Kept `npm run start` in `package.json` for local/dev use; only the container exec chain
  bypasses npm. Direct `node_modules/.bin/next start` is env-equivalent here (PORT/
  NODE_ENV come from the image env, not npm).
- The supervisor honors a clean exit **after** a forwarded stop signal (logs it as
  suspicious-but-honored) — translating those would only distort deploy forensics; docker
  suppresses restart on API stops regardless of code.
- exit-guard is production-gated (`NODE_ENV=production`, `EXIT_GUARD=on/off` override) so
  dev tooling and vitest keep normal exit semantics; it is dependency-free so it can
  install before any other import in `instrumentation.ts`.
- 15:29 stop actor left unattributed (Coolify activity_log empty; sshd shows candidates).
  Chasing it further has no fix value: the class is covered by the AGENTS.md rule and
  honest codes.

## 8. Verification State

- `npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run build` — run on Node 24;
  results recorded in the PR (land.sh re-runs tsc/test/build as the landing gate).
- `bash -n scripts/coolify-prod-start.sh` clean; ASCII-only check clean.
- Box experiments as in §2/§4 (sandbox containers removed; `/tmp/exit0-sandbox*` cleaned).

## 9. Next Steps & Blockers

- **Next deploy/stop will exercise the new supervisor in prod** — check `docker logs`
  for `[coolify-prod-start] app exited with code 143 after forwarded SIGTERM` as the
  live confirmation.
- Optional follow-up: Coolify stop grace is the 10s docker default; next+scheduler flush
  is fast today, but if shutdown work grows, raise the app's stop timeout in Coolify.
- Open question (cosmetic): Coolify's `activity_log` recorded nothing for same-day
  stop/start/restart operations — if actor attribution ever matters, that gap is the
  thing to fix (or route all manual ops through Coolify so they are logged).
