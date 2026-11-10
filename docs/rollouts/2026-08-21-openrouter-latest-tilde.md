# 2026-08-21 — OpenRouter family-latest wire slugs need `~`

#3003 sent display-family `*-latest` ids as `author/slug-latest`. Live
OpenRouter `/api/v1/models` only lists those as `~author/slug-latest`.
The bare ids 404. Availability matching treats `~` as optional, so
rotation still picks Flash / Claude / Grok / Kimi / GPT Mini and then
the chat call dies.

## Wire slugs (verified 2026-08-21)

| Was (404) | Now |
|---|---|
| `google/gemini-flash-latest` | `~google/gemini-flash-latest` |
| `google/gemini-pro-latest` | `~google/gemini-pro-latest` |
| `anthropic/claude-*-latest` | `~anthropic/claude-*-latest` |
| `x-ai/grok-latest` | `~x-ai/grok-latest` |
| `openai/gpt-mini-latest` | `~openai/gpt-mini-latest` |
| `moonshotai/kimi-latest` | `~moonshotai/kimi-latest` |

Flash `:batch` stays `google/gemini-3.7-flash:batch` — the latest alias
has no batch sibling. Dated pins (3.5-flash-lite, gpt-5.6-*, DeepSeek
v4, Mistral medium 3.5) are unchanged.

Display slugs and persisted settings are unchanged.
