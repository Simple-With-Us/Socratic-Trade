# Rollout: Gemini 3.7 Flash class bump

Interactive / default Flash now resolves to OpenRouter `google/gemini-3.7-flash` (Google AI Studio `gemini-3.7-flash`).  Offline eval uses the `:batch` sibling.  The previous catalog wire id `google/gemini-flash-latest` 404s on the live OpenRouter models API.

Catalog aliases (`gemini-flash-latest`) stay for stats aggregation.  Persisted explicit `gemini-3.5-flash` is unchanged on the wire.

Gates: focused llm-provider / llm-request / console-models tests plus `npx tsc --noEmit`.
