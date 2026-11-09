# Provider logos for the model picker

The Assistant model dropdown (`app/ui/model-picker.tsx`) loads a logo per provider from this folder:

| File | Provider |
|------|----------|
| `openai.svg` | OpenAI |
| `anthropic.svg` | Anthropic (Claude) |
| `xai.svg` | xAI (Grok) |
| `gemini.svg` | Google Gemini |
| `mistral.svg` | Mistral |
| `deepseek.svg` | DeepSeek |

All six are present (operator-supplied brand marks, used to identify each model's vendor in the picker).
Each renders on a white tile so dark/transparent marks stay visible in any theme. If a file is ever
missing, the picker falls back to a colored initial chip — no error.

To swap a logo, replace the file in place (keep the exact lowercase `.svg` filename) — no code change.
