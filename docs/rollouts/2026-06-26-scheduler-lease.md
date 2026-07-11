# 2026-06-26 — Single-leader scheduler CAS lease (item #3, durable scheduler) — money-path

Branch `agent/claude-scheduler-lease`. Improvement-program item #3 (durable/locked autonomy scheduler).

> Historical note: this initial rollout intentionally shipped default-off. The 2026-07-11
> correctness follow-up changed current behavior to default-on (including unset/empty env values)
> and added strategy-lock heartbeat-loss enforcement. See
> `docs/rollouts/2026-07-11-strategy-lease-correctness.md`.

## Summary
Prevents two app processes from double-firing the scheduler tick — specifically the synthetic-stop monitor,
which can place broker **EXIT** orders and was only guarded in-process (a second process has its own
`globalThis`, so both would run it).

- New `src/lib/scheduler-lease.ts` — a compare-and-swap lease in the existing `settings` KV table (key
  `scheduler:lease`; **NO new table / migration**), mirroring the proven `acquireStrategyLock` CAS pattern
  (`database.transaction()` wrapping a read + conditional upsert):
  - `acquireLease(owner, ttlMs, now)` — wins if no lease / malformed / expired (`expiresAt <= now`) / already
    owner; else returns false without writing.
  - `renewLease(owner, ttlMs, now)` — extends only if the current owner matches (no steal).
  - `releaseLease(owner)` — deletes only if owner matches; never throws (shutdown-safe).
  - `getLease(now)` — current state + derived `ageMs`/`expired`; never throws.
  - `acquireOrRenewLeadership(now)` — renew-then-acquire (cheap path for the stable leader).
  - **Fails closed**: any exception → `false` → the process behaves as a non-leader and does NOT run the
    money-path body. `LEASE_OWNER = pid:uuid`, `globalThis`-pinned (HMR-safe). TTL default 90s (1.5 ticks).
- `src/lib/scheduler.ts` — gates the per-account tick body (synthetic-stop monitor, pending-fill reconcile,
  `runStrategyOnce`) behind `SCHEDULER_SINGLE_LEADER` (default OFF). `if (singleLeaderEnabled() &&
  !acquireOrRenewLeadership(now)) return;` — when the flag is OFF the `&&` short-circuits, the lease row is
  never touched, and the body runs **byte-for-byte** as today. SIGTERM/SIGINT/beforeExit release the lease
  (registered once via a `globalThis` flag). Pre-gate global refreshes (heartbeat, web sources, filings,
  regime, price alerts) intentionally still run on every process — idempotent, no order placement.
- `app/api/health` + `app/api/ready` — additive `checks.schedulerLease` (owner/age/expired); never affects
  the probe status code.
- `.env.example` — `SCHEDULER_SINGLE_LEADER` + `SCHEDULER_LEASE_TTL_MS`.
- `test/scheduler-lease.test.ts` — 9 tests: only one of two concurrent acquirers wins; expired lease is
  stolen; renew/release only by the current owner; a non-owner can't steal a live lease; `getLease` state.

## Why
Money-path safety on multi-process deploys: a double-fired synthetic-stop tick could place duplicate broker
exit orders. The lease makes the per-account body single-leader. Additive + flag-default-OFF so there is zero
behavior change until explicitly enabled.

## How (model-tiered subagent team)
Run `wf_84becb11-d79`: sonnet recon → **opus design** → sonnet implement → **dual opus review** (correctness +
money-safety lenses). Both reviewers: `implementsSpec / correct / moneySafe / tscGreen / testsGreen` all true,
no required fixes. Independently re-verified by the orchestrator (CAS atomicity, fail-closed direction, gate
placement before the per-account loop, OFF-path byte-for-byte).

## Known limitation (documented, deferred per spec)
A one-tick cross-process TOCTOU window remains — identical to the existing `acquireStrategyLock` (the spec
said to leave that untouched; a genuine atomic fix is a separate PR). Mitigations: TTL-steal semantics, the
pre-existing per-`(user, account)` `stopMonitorInFlight` guard, and flag-default-OFF make a real double-exit
vanishingly unlikely.

## Files
- new `src/lib/scheduler-lease.ts`, `src/lib/scheduler.ts`
- `app/api/health/route.ts`, `app/api/ready/route.ts`, `.env.example`
- new `test/scheduler-lease.test.ts`
- `docs/improvement-program-2026-06-26.md`, `STATUS.md`

## Verification
- `npx tsc --noEmit` clean; `npx vitest run test/scheduler-lease.test.ts` → 9 pass.
- Full `tsc → test → build` trio via `scripts/land.sh`.

## Follow-ups (separate PRs)
- True atomic cross-process CAS (fix the shared `acquireStrategyLock` TOCTOU) — money-path, own reviewed PR.
- Optionally a durable external scheduler/leader election if the deployment grows beyond a single box.
