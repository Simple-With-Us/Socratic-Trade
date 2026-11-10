import { normalizeOpenRouterModelId, stripOpenRouterTilde } from "./llm-provider";
import { canonicalModelId } from "./model-identity";

const AVAILABILITY_CACHE_TTL_MS = 5 * 60 * 1_000;
/** 5s was too tight: every 2026-08-13 scheduled rotation timed out on /models/user. */
const AVAILABILITY_TIMEOUT_MS = 12_000;

type AvailabilityResult =
  | { status: "available"; modelIds: ReadonlySet<string> }
  | { status: "unavailable"; reason: string }
  | { status: "not_checked" };

type CachedAvailability = { expiresAt: number; modelIds: ReadonlySet<string> };
const availabilityCache = new Map<string, CachedAvailability>();

function modelsUserUrl(): string {
  const configured = process.env.OPENROUTER_MODELS_USER_URL?.trim();
  if (configured) return configured;
  const apiUrl = process.env.OPENROUTER_API_URL?.trim() || "https://openrouter.ai/api/v1/chat/completions";
  if (/\/chat\/completions\/?$/i.test(apiUrl)) return apiUrl.replace(/\/chat\/completions\/?$/i, "/models/user");
  if (/\/v1\/?$/i.test(apiUrl)) return `${apiUrl.replace(/\/$/, "")}/models/user`;
  return "https://openrouter.ai/api/v1/models/user";
}

function abortAfter(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

/**
 * Fetch the account-filtered OpenRouter model list. The endpoint reflects the user's provider
 * preferences/guardrails, which is the relevant distinction from merely having an OpenRouter key.
 * Errors are deliberately returned as unavailable: rotation must not select an unknown model.
 */
function cachedAvailability(cacheKey: string, allowStale: boolean): CachedAvailability | undefined {
  const cached = availabilityCache.get(cacheKey);
  if (!cached) return undefined;
  if (allowStale || cached.expiresAt > Date.now()) return cached;
  return undefined;
}

/**
 * `fetchImpl` is an injectable fetcher (defaults to the global `fetch`) so a test can drive the
 * live catalog deterministically — with a fake 200/404/network-error response — without ever
 * reaching the real OpenRouter API.  Passing an explicit `fetchImpl` also SKIPS the
 * `NODE_ENV === "test"` short-circuit below: the short-circuit exists to keep the vitest suite
 * network-free by default, and an injected fetcher already guarantees that, so a test that
 * wants to exercise this function's real parsing/caching/error-handling logic can opt in
 * explicitly instead of always getting the canned `{status:"not_checked"}` reply.
 */
export async function getOpenRouterUserModelAvailability(
  key: string,
  keyRef?: string,
  fetchImpl?: typeof fetch
): Promise<AvailabilityResult> {
  if (process.env.NODE_ENV === "test" && !fetchImpl) return { status: "not_checked" };
  const doFetch = fetchImpl ?? fetch;
  const cacheKey = keyRef || "anonymous-key";
  const fresh = cachedAvailability(cacheKey, false);
  if (fresh) return { status: "available", modelIds: fresh.modelIds };

  const timeout = abortAfter(AVAILABILITY_TIMEOUT_MS);
  try {
    const response = await doFetch(modelsUserUrl(), {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: timeout.signal
    });
    if (!response.ok) {
      const stale = cachedAvailability(cacheKey, true);
      if (stale) return { status: "available", modelIds: stale.modelIds };
      return { status: "unavailable", reason: `http_${response.status}` };
    }
    const payload = (await response.json().catch(() => undefined)) as { data?: Array<{ id?: unknown }> } | undefined;
    const ids = new Set(
      Array.isArray(payload?.data)
        ? payload.data
            .filter((model) => typeof model.id === "string")
            .map((model) => (model.id as string).trim())
            .filter(Boolean)
        : []
    );
    if (ids.size === 0) {
      const stale = cachedAvailability(cacheKey, true);
      if (stale) return { status: "available", modelIds: stale.modelIds };
      return { status: "unavailable", reason: "empty_model_list" };
    }
    availabilityCache.set(cacheKey, { expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_MS, modelIds: ids });
    return { status: "available", modelIds: ids };
  } catch (error) {
    const stale = cachedAvailability(cacheKey, true);
    if (stale) return { status: "available", modelIds: stale.modelIds };
    return { status: "unavailable", reason: error instanceof DOMException && error.name === "AbortError" ? "timeout" : "network_error" };
  } finally {
    timeout.cancel();
  }
}

/** Test-only cache reset; production callers have no reason to clear process-local availability. */
export function clearOpenRouterUserModelAvailabilityCache(): void {
  availabilityCache.clear();
}

/**
 * True when the catalog/wire id is the same OpenRouter model class as a listed
 * `/models/user` row.  Exact normalized id still wins.  `~` on latest aliases
 * is optional.  Alias/version pairs also match (`claude-haiku-4.5` ↔
 * `~anthropic/claude-haiku-latest`, `gemini-flash-latest` ↔
 * `google/gemini-3.7-flash`, vendor prefix optional) so a successful user-list
 * that returns tildes or dated slugs cannot empty the rotation pool.
 */
function availabilityKeys(model: string): string[] {
  const trimmed = model.trim();
  const normalized = normalizeOpenRouterModelId(trimmed);
  return [...new Set([trimmed, normalized, stripOpenRouterTilde(trimmed), stripOpenRouterTilde(normalized)])];
}

export function isOpenRouterModelAvailable(model: string, modelIds: ReadonlySet<string>): boolean {
  const listed = new Set<string>();
  for (const id of modelIds) {
    for (const key of availabilityKeys(id)) listed.add(key);
  }
  if (availabilityKeys(model).some((key) => listed.has(key))) return true;
  const family = canonicalModelId(model);
  if (!family) return false;
  for (const id of modelIds) {
    if (canonicalModelId(id) === family) return true;
  }
  return false;
}
