import { resolveRequestUserId } from "@/lib/request-user";
import { resolveLlmCredential } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/chat/providers — per-provider key availability for the Assistant model picker.
 * Returns ONLY booleans (never the key) so the dropdown can mark a provider whose key isn't
 * resolvable for this user. "Resolvable" uses resolveLlmCredential — the same check llmForModel
 * makes to decide real-vs-mock — so a provider shows available whenever the app can actually serve
 * it for this user. No distinction is drawn here between a user's own key and any other resolved key.
 *
 * Includes "openrouter": llmForModel now routes EVERY model through an OpenRouter key first
 * (same universal-routing precedence resolveLlmEndpoint already uses for the strategy engine —
 * see llm-provider.ts). Without this row, an owner with only an OpenRouter key attached saw every
 * Coach model reported as "no key" even though the same model already worked in the strategy
 * engine (review finding llm-12). Also includes "meta" (llama-family models) — omitted before for
 * the same reason: chatProviderForModel had no llama mapping, so the UI could never have reported
 * status for it correctly anyway.
 */
export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const services = ["openai", "anthropic", "xai", "gemini", "mistral", "deepseek", "meta", "moonshot", "minimax", "openrouter"] as const;
  const providers: Record<string, boolean> = {};
  for (const service of services) {
    providers[service] = Boolean(resolveLlmCredential(service, userId).key);
    // Llama and Glimmer are OpenRouter-only, so an OpenRouter key also makes "meta" available.
    if (service === "meta" && !providers[service]) providers[service] = Boolean(resolveLlmCredential("openrouter", userId).key);
  }
  return NextResponse.json({ providers });
}
