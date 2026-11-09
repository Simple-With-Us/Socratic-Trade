# Autopilot accounts + rotation timeout fail-open

## What

Scheduled strategy runs failed all morning on 2026-08-13 with
`Choose both the Green Team (strategist) and Red Team (reviewer) models`
even though both seats were `__rotate__`.  Prod `model_rotation_pick`
audits show `outcome=availability_unavailable` / `availabilityError=timeout`
on every failed run after 16:30Z.  `eligibleRotationPool` emptied the
credential-filtered pool when OpenRouter `/models/user` timed out (5s),
then `resolveOpenAiModel` treated the sentinel as unset.

Roth IRA, Alpaca Paper, and Tradier Sandbox already had
`strategyAuthority=decide`.  All three were `systemState=halted` (boot
interlock after deploys).  Sandbox is labeled `Sandbox`.

## Fix

- Fail OPEN to the credential-filtered rotation pool on availability
  timeout / 429 / 5xx.  Reuse a stale `/models/user` cache when the live
  fetch fails.
- Raise the availability timeout 5s → 12s.
- If rotation still cannot pick a Green model, persist the honest
  rotation message instead of "Choose both team models".
- Human vocab: **Autopilot** only when the account is auto-deciding.
  Autonomy on + ask-first is **Running**.  Shared helper
  `src/lib/autonomy-labels.ts`; console / PWA / ops / `/api/health`.
- `scripts/set-autopilot-accounts.ts` (dry-run default, `--apply` writes)
  arms the three named accounts and turns on `autoResumeOnBoot`.

## Do not

Restart the production container to "unstick" runs.  Boot interlock
halts every active account unless auto-resume is on.

## Owner click remaining

After this lands and Coolify deploys (no extra restart): run

`npx tsx scripts/set-autopilot-accounts.ts --apply`

against the prod DB, or in Guardrails for each of Roth IRA / Alpaca
Paper / Tradier Sandbox: Start (Running) with Autopilot already set,
and enable Auto-resume on boot in Settings.  Do not restart the
container by hand.
