import { getUserSetting } from "./db-settings";

/**
 * Providers that can be reached either through OpenRouter (the default) or directly with the
 * user's own key.  The choice is a per-user setting, shown next to the key in Settings.
 */
export const NATIVE_ROUTE_SERVICES = ["meta", "minimax"] as const;
export type NativeRouteService = (typeof NATIVE_ROUTE_SERVICES)[number];
export type LlmRoute = "openrouter" | "native" | "code-cli";

export function isNativeRouteService(service: string): service is NativeRouteService {
  return (NATIVE_ROUTE_SERVICES as readonly string[]).includes(service);
}

export function llmRouteSettingKey(service: NativeRouteService): string {
  return `llm_route_${service}`;
}

/** The user's chosen route for a provider.  OpenRouter unless they explicitly picked native. */
export function llmRouteFor(service: NativeRouteService, userId: string = "local"): LlmRoute {
  const route = getUserSetting<string>(userId, llmRouteSettingKey(service), "openrouter");
  return route === "native" || route === "code-cli" ? route : "openrouter";
}
