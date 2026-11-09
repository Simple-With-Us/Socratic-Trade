# 2026-06-23 - Green/Red LLM routing

## Summary

Recovered the useful part of the split-model LLM setup from the dirty
`/Users/jay/apps/trading-codex` worktree and applied it to the current clean
task worktree. The app now has a Green Team model for proposal generation and an
optional Red Team model for Bear review. If no Red Team model is selected, Red
uses Green.

## Why

The prior UI had one generic AI model dropdown, which meant the Bull proposer and
Bear reviewer used the same model unless an env-only Anthropic override was set.
That also left legacy `gpt-4.1-mini` visible in the dropdown even though the app
already lists `gpt-5.4-nano` as the cheapest GPT-5-class option.

## Files

- `src/lib/types.ts` - added `redTeamLlmModel`.
- `src/lib/llm-provider.ts` - added team-role-aware model resolution.
- `src/lib/strategy.ts` - routes Bear review through Red Team model and records
  separate `strategy-bear` usage.
- `src/lib/red-team.ts` - standalone Red Team debate uses Red Team model unless
  the Anthropic emergency env override is explicitly configured.
- `src/lib/llm-usage.ts` - added Grok pricing estimates.
- `app/dashboard-client.tsx` - split model selector into Green Team and Red
  Team controls, later moved to Strategy Studio after UI review; removed visible
  `gpt-4.1-mini`; normalized OpenAI/Grok labels. Settings -> Connections keeps
  provider keys and a read-only model summary.
- `app/api/policy/route.ts` - validates and clears the optional Red Team model.
- `.env.example`, `PLAN.md`, `STATUS.md`, `docs/phase-11-multi-user.md` - docs.
- `test/llm-provider.test.ts` - regression coverage for Red Team model routing.

## Verification

- `npx tsc --noEmit` - clean.
- `npm test` - 97 files passed, 888 tests passed.
- `npm run build` - clean.
- Focused Playwright smoke against `next start` on `127.0.0.1:4214` with the
  local Cloudflare Access test header - opened Settings, verified Green Team and
  Red Team model controls, verified the OpenAI/Grok option labels, and verified
  `gpt-4.1-mini` is not visible in the model options.

## Follow-ups

- Same-day UI placement update is documented in
  `docs/rollouts/2026-06-23-ui-expert-strategy-macro-errors.md`.
- 2026-06-29: Claude (Anthropic) is now a first-class Green/Red Team model too —
  `resolveLlmEndpoint` routes `claude-*` through a new `anthropic-messages`
  transport and a shared request builder uses Anthropic forced tool-use for JSON.
  See `docs/rollouts/2026-06-29-claude-green-red-team.md`.
- The broader dirty `agent/codex` patch also contained `/api/llm-settings` and
  richer usage UI, plus unrelated Alpaca/account edits. Those were not copied
  wholesale to avoid overwriting or mixing active work.
