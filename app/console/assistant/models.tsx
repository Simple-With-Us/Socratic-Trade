/** Chat-model catalog for the console assistant's native grouped <select>.
 *
 *  Model ids MUST match what POST /api/chat routes on (see chatProviderForModel
 *  in src/lib/chat/llm.ts: claude-* -> anthropic, grok-* -> xai, gemini-* ->
 *  gemini, mistral-family -> mistral, deepseek-* -> deepseek, else openai).
 *  The grouped options come directly from app/ui/llm-model-catalog.ts so the
 *  Coach, Green/Red teams, model stats, and AI review cannot silently diverge.
 *  Provider routing/labels below delegate to that shared module. */

import { providerForModel as consoleProviderForModel, providerLabel, type ConsoleProviderId } from "../lib/models";
import { CHAT_MODEL_GROUPS, type ModelGroup, type ModelOption } from "../../ui/llm-model-catalog";

export type { ModelGroup, ModelOption };

export const CHAT_MODEL_STORAGE_KEY = "console.assistant.model";
export const CHAT_REASONING_STORAGE_KEY = "console.assistant.reasoning";

/** Sentinel select value meaning "type a model id yourself". */
export const CUSTOM_MODEL_VALUE = "custom";

export const MODEL_GROUPS: ModelGroup[] = CHAT_MODEL_GROUPS;

export const CATALOG_MODEL_IDS = new Set(MODEL_GROUPS.flatMap((g) => g.options.map((o) => o.value)));

/** Provider a chat request with this model would hit. */
export function providerForModel(model: string): ConsoleProviderId {
  return consoleProviderForModel(model);
}

export function providerDisplayName(provider: ConsoleProviderId): string {
  return providerLabel(provider);
}
