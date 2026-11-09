# 2026-06-26 — Cutover script: prompt for the Infisical token (no more export footgun)

## Summary

`scripts/infisical-prod-cutover.sh` required `INFISICAL_TOKEN` in the environment
and errored otherwise. Running the assignment on its OWN line (`INFISICAL_TOKEN=…`
then `bash scripts/…` separately) sets a **non-exported** shell variable that the
child script never inherits — a common stumble. Now:

- When the token isn't in the env or `deploy.env` AND stdin is a terminal, the
  script **prompts for it with hidden input** (`read -rs`) — both the app token
  and (optionally) the shared-at-ct token; pressing Enter skips the shared overlay.
- The non-interactive "no token" error now explains the fix: pass it inline on the
  same line, `export` it, or run interactively. A bare `VAR=value` line is not
  inherited.

## Why

The operator hit "Set INFISICAL_TOKEN … and re-run" twice because the assignment
was on its own line (not exported). A hidden prompt removes the footgun and avoids
putting the token on the command line / in shell history.

## Files

- `scripts/infisical-prod-cutover.sh` — hidden interactive token prompt (app +
  shared) when unset + TTY; clearer non-interactive error; usage note.

## Verification

- `bash -n` clean.
- With fake `infisical`/`pm2` shims + an isolated HOME: no-token + non-TTY → clear
  error, **no hang**; token via env + `--no-restart` → runs to "Cutover complete".

## Follow-ups

- None. After this deploys, the box's copy of the script updates automatically;
  re-run `bash scripts/infisical-prod-cutover.sh` and it will prompt for the token.
