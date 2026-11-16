# 2026-07-03 - AI Review inheritance, model catalog, and text-box fonts

## Summary

- Removed misleading account-level fallback language from the console Strategy -> AI Review model picker.
- Changed AI Review's blank model behavior to inherit the configured Red Team model first, then the Green Team model.
- Trimmed empty model overrides at `/api/strategy/tune` so an empty string cannot become a fake model override.
- Changed console text boxes from forced monospace to the site font by default, with Settings -> Appearance choices for Site, System, Serif, and Mono text-box fonts.
- Refreshed curated non-OpenAI/non-Anthropic model choices from current provider docs:
  `gemini-3.1-flash-lite`, `gemini-3.5-flash`, `gemini-3.1-pro-preview`,
  `mistral-small-2603`, `mistral-medium-3-5`, `grok-4.3`, `grok-build-0.1`,
  and DeepSeek V4.
- Added DeepSeek V4 provider-specific Thinking Mode handling (`none`, `high`, `max`) and matching UI/backend normalization.

## Why

- The old account-level fallback label did not describe a real user choice and implied a separate account-review model.
- Account review should reuse the existing team model configuration unless the user explicitly chooses a reviewer model for that one review.
- The Strategy prompt textarea was visually reading like code because `.con-textarea` forced a monospace stack; long prose should default to the console's normal UI font.
- Provider model selectors should not advertise stale IDs as first-class choices when newer current IDs are available and wired.

## Files

- `app/console/strategy/page.tsx`
- `app/console/assistant/chat.tsx`
- `app/console/assistant/models.tsx`
- `app/console/components/shell.tsx`
- `app/console/console.css`
- `app/console/lib/models.ts`
- `app/console/lib/useConsoleTextBoxFont.ts`
- `app/console/settings/models.tsx`
- `app/console/settings/page.tsx`
- `app/dashboard-client.tsx`
- `app/ui/llm-model-catalog.ts`
- `app/api/keys/route.ts`
- `app/api/strategy/tune/route.ts`
- `docs/phase-11-multi-user.md`
- `src/lib/strategy-tuning.ts`
- `src/lib/llm-request.ts`
- `src/lib/llm-usage.ts`
- `src/lib/usage-budget.ts`
- `test/llm-request.test.ts`
- `test/strategy-tuning.test.ts`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-03-ai-review-model-inheritance.md`

## Verification

- `npx vitest run test/llm-request.test.ts test/strategy-tuning.test.ts` - passed (2 files / 23 tests)
- `npm run lint` - passed (0 errors, 307 existing warnings)
- `npx tsc --noEmit` - passed
- `npm test` - passed (244 files / 2370 tests)
- `npm run build` - passed
- `git diff --check` - passed
- `pm2 restart trading-codex --update-env` - succeeded
- `curl -I --max-time 10 http://127.0.0.1:4101/console/settings` - `307` to `/login` as expected without an authenticated session
- `curl -I --max-time 10 http://127.0.0.1:4101/console/strategy` - `307` to `/login` as expected without an authenticated session

## Follow-ups

- Consider centralizing the three visible picker catalogs into one pure data module so Strategy, Settings, and Assistant cannot drift again.
