# 2026-06-22 - Autonomy status chip: clearer run-state + mode label

## Summary

The header status chip showed **"Inactive"** even right after choosing the
**Autonomous** approval mode, which looked contradictory. Root cause: the chip
reflects the **run state** (`systemState`, controlled by Start/Stop), not the
**approval mode** (`strategyAuthority` = propose/decide). Choosing a mode never
starts the system — Start is the deliberate "go" gate — so the system stays
halted (and the chip said "Inactive") until Start is pressed.

Relabeled for clarity and to reflect the chosen mode once running:

- `halted` → **"Stopped"** (was "Inactive"; now matches the Start/Stop button).
- `active` + setup incomplete → **"Setup Needed"** (unchanged).
- `active` + `decide` → **"Running · Autonomous"** (was "Autonomy On").
- `active` + `propose` → **"Running · Propose"**.
- other states (`liquidating`/`close_only`) → `Autonomy <state>` (unchanged fallback).

So after choosing Autonomous **and** pressing Start, the chip reads
"Running · Autonomous"; before Start it reads "Stopped". This makes the
mode-vs-run-state distinction obvious instead of looking like a contradiction.

## Files

- `app/dashboard-client.tsx` — `autonomyStatus` label/tone logic.
- `STATUS.md`, this rollout note.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run build` — succeeds.
- UI-only; no unit test covers this label. No code referenced the old
  "Inactive"/"Autonomy On" strings (grep clean).

## Notes

- Behavior unchanged: selecting a mode does not start the system (safety gate).
  This is purely a labeling/clarity fix.
- Prior deploy verification: Deploy run #17 (PR #100) succeeded on `main`; site 302.
