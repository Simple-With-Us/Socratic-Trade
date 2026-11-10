/**
 * Per-user source feature settings — overrides for knobs that used to be Infisical-only.
 *
 * Resolution order for each catalog id:
 *   1. user_settings key `source_settings` map entry (if present)
 *   2. server-knob DB override, for the ids that are ALSO server knobs (Admin > Operations —
 *      currently SEC_FILING_RAG_MAX_PER_RUN; see src/lib/server-knobs.ts)
 *   3. process.env[id] when the id looks like an env var (ALL_CAPS / underscores)
 *   4. catalog defaultValue
 */

import { LOCAL_USER } from "./db-api-keys";
import { getUserSetting, setUserSetting } from "./db-settings";
import { envFlagOn } from "./rag/env-flag";
import { serverKnobOverride } from "./server-knobs";
import {
  SOURCE_SETTINGS_CATALOG,
  sourceSettingById,
  type SourceSettingSpec
} from "./source-settings-catalog";

export const SOURCE_SETTINGS_USER_KEY = "source_settings";

export type SourceSettingsMap = Record<string, boolean | number | string>;

export function getUserSourceSettingsMap(userId: string = LOCAL_USER): SourceSettingsMap {
  // Fail-open: resolvers below sit on enrichment/data-plane hot paths (e.g. the news-relevance
  // knobs read inside provider enrich() calls), where a settings-store failure must degrade to
  // env/catalog defaults — never abort the caller. Also keeps DB-mocking tests from having to
  // stub the settings table just because a provider consults a knob.
  try {
    return getUserSetting<SourceSettingsMap>(userId, SOURCE_SETTINGS_USER_KEY, {});
  } catch {
    return {};
  }
}

export function setUserSourceSettingsMap(
  userId: string,
  next: SourceSettingsMap,
  options?: { auditPolicyChange?: boolean }
): void {
  // Validate keys against catalog
  const clean: SourceSettingsMap = {};
  for (const [k, v] of Object.entries(next)) {
    const spec = sourceSettingById(k);
    if (!spec) continue;
    const coerced = coerceValue(spec, v);
    if (coerced !== undefined) clean[k] = coerced;
  }
  setUserSetting(userId, SOURCE_SETTINGS_USER_KEY, clean, options);
}

/** Merge patch into existing map (undefined deletes / resets to env+default). */
export function patchUserSourceSettings(
  userId: string,
  patch: Record<string, boolean | number | string | null | undefined>
): SourceSettingsMap {
  const cur = { ...getUserSourceSettingsMap(userId) };
  for (const [k, v] of Object.entries(patch)) {
    const spec = sourceSettingById(k);
    if (!spec) continue;
    if (v === null || v === undefined) {
      delete cur[k];
      continue;
    }
    const coerced = coerceValue(spec, v);
    if (coerced !== undefined) cur[k] = coerced;
  }
  setUserSourceSettingsMap(userId, cur);
  return cur;
}

function coerceValue(
  spec: SourceSettingSpec,
  raw: unknown
): boolean | number | string | undefined {
  if (spec.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "string") {
      const t = raw.trim().toLowerCase();
      if (["1", "true", "on", "yes"].includes(t)) return true;
      if (["0", "false", "off", "no"].includes(t)) return false;
    }
    if (typeof raw === "number") return raw !== 0;
    return undefined;
  }
  if (spec.type === "number") {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return undefined;
    let v = n;
    if (typeof spec.min === "number") v = Math.max(spec.min, v);
    if (typeof spec.max === "number") v = Math.min(spec.max, v);
    return v;
  }
  if (typeof raw === "string") return raw;
  if (raw == null) return undefined;
  return String(raw);
}

function envLooksLikeFlag(id: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(id);
}

/** Resolve a boolean source setting for a user. */
export function resolveSourceBool(id: string, userId: string = LOCAL_USER): boolean {
  const spec = sourceSettingById(id);
  const default_ = typeof spec?.defaultValue === "boolean" ? spec.defaultValue : false;

  const map = getUserSourceSettingsMap(userId);
  if (Object.prototype.hasOwnProperty.call(map, id)) {
    return Boolean(map[id]);
  }
  const server = serverKnobOverride(id); // no-op unless the id is also a server knob with a DB override
  if (typeof server === "boolean") return server;
  if (envLooksLikeFlag(id)) {
    return envFlagOn(id, default_);
  }
  return default_;
}

export function resolveSourceNumber(id: string, userId: string = LOCAL_USER): number {
  const spec = sourceSettingById(id);
  const default_ = typeof spec?.defaultValue === "number" ? spec.defaultValue : 0;
  const map = getUserSourceSettingsMap(userId);
  if (Object.prototype.hasOwnProperty.call(map, id)) {
    const n = Number(map[id]);
    if (Number.isFinite(n)) {
      let v = n;
      if (typeof spec?.min === "number") v = Math.max(spec.min, v);
      if (typeof spec?.max === "number") v = Math.min(spec.max, v);
      return v;
    }
  }
  // Server-knob override tier (deliberately unclamped by THIS catalog's min/max: the server
  // catalog validated the write, and e.g. SEC_FILING_RAG_MAX_PER_RUN=0 is a real pause).
  const server = serverKnobOverride(id);
  if (typeof server === "number" && Number.isFinite(server)) return server;
  if (envLooksLikeFlag(id) && process.env[id] != null && process.env[id] !== "") {
    const n = Number(process.env[id]);
    if (Number.isFinite(n)) return n;
  }
  return default_;
}

export function resolveSourceString(id: string, userId: string = LOCAL_USER): string {
  const spec = sourceSettingById(id);
  const default_ = typeof spec?.defaultValue === "string" ? spec.defaultValue : "";
  const map = getUserSourceSettingsMap(userId);
  if (Object.prototype.hasOwnProperty.call(map, id) && typeof map[id] === "string") {
    return map[id] as string;
  }
  if (envLooksLikeFlag(id) && process.env[id] != null) {
    return String(process.env[id]);
  }
  return default_;
}

/** Effective values for Settings UI: catalog + current resolve + override flag. */
export function listEffectiveSourceSettings(userId: string = LOCAL_USER): Array<{
  spec: SourceSettingSpec;
  value: boolean | number | string;
  source: "user" | "server" | "env" | "default";
}> {
  const map = getUserSourceSettingsMap(userId);
  return SOURCE_SETTINGS_CATALOG.map((spec) => {
    let source: "user" | "server" | "env" | "default" = "default";
    let value: boolean | number | string = spec.defaultValue;
    const server = serverKnobOverride(spec.id);
    if (Object.prototype.hasOwnProperty.call(map, spec.id)) {
      source = "user";
      value = map[spec.id]!;
    } else if (server !== undefined) {
      // Server-level override set in Admin > Operations — replaces the env tier for this id.
      source = "server";
      value = server;
    } else if (envLooksLikeFlag(spec.id) && process.env[spec.id] != null && process.env[spec.id] !== "") {
      source = "env";
      if (spec.type === "boolean") value = envFlagOn(spec.id, Boolean(spec.defaultValue));
      else if (spec.type === "number") {
        const n = Number(process.env[spec.id]);
        value = Number.isFinite(n) ? n : (spec.defaultValue as number);
      } else value = String(process.env[spec.id]);
    } else {
      value = spec.defaultValue;
    }
    return { spec, value, source };
  });
}
