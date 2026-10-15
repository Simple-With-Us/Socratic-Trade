# Codex Cloud protocol bootstrap (Socratic-Trade)

## Summary

Added repo-local Codex Cloud setup and maintenance hooks for the shared fleet protocols.

## Runtime environment contract

These must be configured as regular runtime environment variables when the agent phase needs them:

- `GH_TOKEN`
- Zulip: `ZULIP_RC` or `ZULIP_EMAIL` + `ZULIP_API_KEY` + `ZULIP_SITE`

Optional coordination variables:

- `AGENT_SEAT=Codex` (default CODEX)
- `CODEX_PROJECT=Socratic-Trade`
- `CODEX_COORD_TOPIC=fleet`

Secret-category variables are available only during setup and are removed before the agent phase. Setup scripts therefore validate presence but do not persist secrets into dotfiles.

## Protocol coverage

- Zulip: `scripts/codex-coordination.sh read|post|test` (via `agent-sync`)
- Effort logs: `AGENTS.md` and `docs/EFFORT-LOG.md`
- GitHub: setup validates API, issue, and PR access through `gh`
- Apple Notes: Mac-only; cloud agents must include a completion-note handoff body for local publication

## Verification

Run:

```bash
bash .codex/setup.sh
bash .codex/maintenance.sh
```

