/**
 * App-level settings via Infisical — the sole source of truth, in-memory cache edition.
 *
 * Fleet directive 2026-10-03: Infisical is the SOT for secrets, env config, and tunable
 * settings knobs.  This module implements the canonical runtime contract for
 * Socratic-Trade (see INFISICAL.md at the repo root):
 *
 *   1. Load at startup.  initInfisicalSettings() populates an in-memory Map once,
 *      during instrumentation.  Merge order honors the repo's 2026-08-20 rule:
 *      the shared project loads first, the app project shadows it.
 *   2. Never fetch per-request.  get()/peek()/getAll()/has() read memory ONLY —
 *      safe in hot request/tick/stream paths.
 *   3. Background refresh.  A 5-minute interval timer (plus a SIGHUP handler)
 *      re-reads Infisical; refresh failures log loudly and keep serving the
 *      last-known-good cache — staleness is safer than an outage.
 *   4. Write-through.  setSetting() writes to the APP Infisical project FIRST,
 *      then updates the cache.  A failed Infisical write fails the save; the
 *      cache and Infisical never diverge silently.
 *
 * Credential modes (deliberate, documented in INFISICAL.md — NOT a bug):
 *   - CREDENTIALED: universal-auth clientId/clientSecret supplied via options or
 *     INFISICAL_CLIENT_ID / INFISICAL_CLIENT_SECRET env.  Full contract above.
 *   - UNREDENTIALED (production): scripts/infisical-run.mjs scrubs every
 *     bootstrap credential from the app process by design, so no long-lived
 *     Infisical identity reaches this process.  init() then seeds the cache
 *     from the runner-injected process.env — which IS the Infisical-sourced,
 *     shared+app-merged truth snapshotted at boot.  Reads stay memory-only;
 *     refresh and write-through are unavailable and say so loudly instead of
 *     pretending.
 *
 * Init is FAIL-SOFT by design: a failed credentialed init falls back to the
 * boot-env snapshot rather than taking the trading box down.  The failure is
 * logged loudly and visible via infisicalSettingsStatus() / the admin
 * settings-reload route.  This matches the repo's existing fail-open knob
 * philosophy (src/lib/server-knobs.ts): the runner already injected the
 * Infisical values into process.env, so there is always a good snapshot.
 *
 * Reuses createInfisicalSettings from @jaywedgeworth22/congress-trading-shared
 * (the fleet pilot module, PR #329) — zero new runtime dependencies.
 */

import {
  createInfisicalSettings,
  type InfisicalSettings,
  InfisicalWriteError
} from "@jaywedgeworth22/congress-trading-shared";

/** Socratic-Trade's own Infisical project (workspaceId). */
export const APP_INFISICAL_PROJECT_ID = "39d93bb7-76f9-498c-8b50-a7def52e072f";
/** Fleet shared project (shared-at-ct) — loads first; the app project shadows it. */
export const SHARED_INFISICAL_PROJECT_ID = "18f563a3-9c88-454c-96eb-28fc9678f3ba";
/** Background cache refresh interval (canonical pattern default: 5 minutes). */
export const DEFAULT_SETTINGS_REFRESH_MS = 5 * 60 * 1000;

const LOG_PREFIX = "[infisical-settings]";

export interface InitInfisicalSettingsOptions {
  /** Universal-auth client ID.  Defaults to INFISICAL_CLIENT_ID env. */
  clientId?: string;
  /** Universal-auth client secret.  Defaults to INFISICAL_CLIENT_SECRET env. */
  clientSecret?: string;
  /** App project override.  Defaults to INFISICAL_PROJECT_ID env, then APP_INFISICAL_PROJECT_ID. */
  appProjectId?: string;
  /** App environment slug.  Defaults to INFISICAL_ENV env, then "prod".  Only "prod" is accepted. */
  appEnvironment?: string;
  /** Shared project override.  Defaults to INFISICAL_SHARED_PROJECT_ID env, then SHARED_INFISICAL_PROJECT_ID. */
  sharedProjectId?: string | null;
  /** Shared environment slug.  Defaults to INFISICAL_SHARED_ENV env, then the app environment.  Only "prod" is accepted. */
  sharedEnvironment?: string;
  /** Infisical instance base URL.  Defaults to https://app.infisical.com. */
  infisicalUrl?: string;
  /** Background refresh interval ms.  <= 0 disables the timer.  Defaults to DEFAULT_SETTINGS_REFRESH_MS. */
  refreshIntervalMs?: number;
  /** fetch implementation.  Defaults to globalThis.fetch.  Inject a mock in tests. */
  fetchImpl?: typeof fetch;
}

export interface InfisicalSettingsStatus {
  initialized: boolean;
  credentialed: boolean;
  keys: number;
  lastRefreshAt: number | null;
  lastInitError: string | null;
  refreshIntervalMs: number;
}

export interface RefreshResult {
  refreshed: boolean;
  reason: "ok" | "uncredentialed" | "error" | "not-initialized";
  keys: number;
  error?: string;
}

interface ServiceState {
  app: InfisicalSettings | null;
  shared: InfisicalSettings | null;
  merged: Map<string, string>;
  initialized: boolean;
  credentialed: boolean;
  lastRefreshAt: number | null;
  lastInitError: string | null;
  refreshIntervalMs: number;
}

function freshState(): ServiceState {
  return {
    app: null,
    shared: null,
    merged: new Map(),
    initialized: false,
    credentialed: false,
    lastRefreshAt: null,
    lastInitError: null,
    refreshIntervalMs: DEFAULT_SETTINGS_REFRESH_MS
  };
}

type HostFlags = typeof globalThis & {
  __infisicalSettings?: ServiceState;
  __infisicalSettingsTimer?: ReturnType<typeof setInterval>;
  __infisicalSettingsSighup?: boolean;
  __infisicalSettingsInitPromise?: Promise<InfisicalSettingsStatus> | null;
};

// Process-level singleton so HMR / test re-evaluation cannot spawn a second
// timer or a second cache.
function state(): ServiceState {
  const host = globalThis as HostFlags;
  if (!host.__infisicalSettings) host.__infisicalSettings = freshState();
  return host.__infisicalSettings;
}

function resolveAppProjectId(options: InitInfisicalSettingsOptions): string {
  return (
    options.appProjectId ?? process.env.INFISICAL_PROJECT_ID ?? APP_INFISICAL_PROJECT_ID
  );
}

/** prod is the only Infisical environment (owner 2026-10-10: dev and staging are retired). */
const INFISICAL_ENVIRONMENT = "prod";

function requireProdEnvironment(label: "app" | "shared", value: string): void {
  if (value !== INFISICAL_ENVIRONMENT) {
    throw new Error(
      `${label} Infisical environment must be "${INFISICAL_ENVIRONMENT}" ` +
        `(dev and staging are retired); got "${value.slice(0, 32)}"`
    );
  }
}

function resolveAppEnvironment(options: InitInfisicalSettingsOptions): string {
  return options.appEnvironment ?? process.env.INFISICAL_ENV ?? INFISICAL_ENVIRONMENT;
}

function resolveSharedProjectId(options: InitInfisicalSettingsOptions): string | null {
  if (options.sharedProjectId !== undefined) return options.sharedProjectId;
  return process.env.INFISICAL_SHARED_PROJECT_ID ?? SHARED_INFISICAL_PROJECT_ID;
}

/** Snapshot the runner-injected boot environment into the cache. */
function seedFromBootEnv(s: ServiceState, reason: string): void {
  const snapshot = new Map<string, string>();
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") snapshot.set(k, v);
  }
  s.merged = snapshot;
  s.credentialed = false;
  s.app = null;
  s.shared = null;
  console.error(
    `${LOG_PREFIX} ${reason} Seeded settings cache from the runner-injected boot environment ` +
      `(${snapshot.size} keys) — values are Infisical-sourced as of process start. ` +
      `Background refresh and write-through are unavailable in this process; ` +
      `see INFISICAL.md.`
  );
}

/** Merge shared-first, app-shadow — the repo's 2026-08-20 merge order. */
function mergeProjects(s: ServiceState): Map<string, string> {
  const merged = new Map<string, string>();
  if (s.shared) {
    for (const [k, v] of Object.entries(s.shared.getAll())) merged.set(k, v);
  }
  if (s.app) {
    for (const [k, v] of Object.entries(s.app.getAll())) merged.set(k, v);
  }
  return merged;
}

async function refreshAll(): Promise<RefreshResult> {
  const s = state();
  if (!s.initialized) {
    return { refreshed: false, reason: "not-initialized", keys: 0 };
  }
  if (!s.credentialed || !s.app) {
    return { refreshed: false, reason: "uncredentialed", keys: s.merged.size };
  }
  try {
    if (s.shared) await s.shared.refresh();
    await s.app.refresh();
    s.merged = mergeProjects(s);
    s.lastRefreshAt = Date.now();
    s.lastInitError = null;
    return { refreshed: true, reason: "ok", keys: s.merged.size };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // LOUD log, then keep serving the last-known-good merged cache.
    console.error(
      `${LOG_PREFIX} Refresh failed: ${message}. Serving last-known-good cache ` +
        `(${s.merged.size} keys); staleness is safer than an outage.`
    );
    return { refreshed: false, reason: "error", keys: s.merged.size, error: message };
  }
}

function startRefreshTimer(s: ServiceState, intervalMs: number): void {
  const host = globalThis as HostFlags;
  if (host.__infisicalSettingsTimer) return;
  if (intervalMs <= 0) return;
  s.refreshIntervalMs = intervalMs;
  const timer = setInterval(() => {
    void refreshAll().catch(() => {
      // refreshAll never throws (it returns a result), this is belt-and-braces.
    });
  }, intervalMs);
  const maybeUnref = timer as { unref?: () => void };
  if (typeof maybeUnref.unref === "function") maybeUnref.unref();
  host.__infisicalSettingsTimer = timer;
}

function installSighupHandler(): void {
  const host = globalThis as HostFlags;
  const proc = (globalThis as { process?: { on?: (ev: string, fn: () => void) => void } }).process;
  if (host.__infisicalSettingsSighup || typeof proc?.on !== "function") return;
  host.__infisicalSettingsSighup = true;
  proc.on("SIGHUP", () => {
    console.error(`${LOG_PREFIX} SIGHUP received — refreshing settings cache.`);
    void refreshAll();
  });
}

/**
 * Load the settings cache at startup.  Safe to call repeatedly (second and
 * later calls return the first call's result).  NEVER throws: on any failure
 * it falls back to the boot-env snapshot and records the error in status.
 */
export function initInfisicalSettings(
  options: InitInfisicalSettingsOptions = {}
): Promise<InfisicalSettingsStatus> {
  const host = globalThis as HostFlags;
  if (host.__infisicalSettingsInitPromise) return host.__infisicalSettingsInitPromise;
  host.__infisicalSettingsInitPromise = (async (): Promise<InfisicalSettingsStatus> => {
    const s = state();
    if (s.initialized) return status();
    const refreshMs =
      options.refreshIntervalMs === undefined ? DEFAULT_SETTINGS_REFRESH_MS : options.refreshIntervalMs;
    const clientId = options.clientId ?? process.env.INFISICAL_CLIENT_ID;
    const clientSecret = options.clientSecret ?? process.env.INFISICAL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      seedFromBootEnv(
        s,
        "No universal-auth credentials in this process (expected in production — the secrets " +
          "runner scrubs bootstrap credentials by design)."
      );
      s.initialized = true;
      installSighupHandler();
      return status();
    }

    const appProjectId = resolveAppProjectId(options);
    const appEnv = resolveAppEnvironment(options);
    const sharedProjectId = resolveSharedProjectId(options);
    const sharedEnv = options.sharedEnvironment ?? process.env.INFISICAL_SHARED_ENV ?? appEnv;
    try {
      // Inside the try on purpose:  a stray non-prod value takes the same
      // loud, fail-soft path as any other failed credentialed init.
      requireProdEnvironment("app", appEnv);
      if (sharedProjectId) requireProdEnvironment("shared", sharedEnv);
      s.app = createInfisicalSettings({
        projectId: appProjectId,
        environment: appEnv,
        clientId,
        clientSecret,
        infisicalUrl: options.infisicalUrl,
        refreshIntervalMs: 0, // this service owns the single merge timer
        fetchImpl: options.fetchImpl
      });
      if (sharedProjectId) {
        s.shared = createInfisicalSettings({
          projectId: sharedProjectId,
          environment: sharedEnv,
          clientId,
          clientSecret,
          infisicalUrl: options.infisicalUrl,
          refreshIntervalMs: 0,
          fetchImpl: options.fetchImpl
        });
        await s.shared.init();
      }
      await s.app.init();
      s.merged = mergeProjects(s);
      s.credentialed = true;
      s.lastRefreshAt = Date.now();
      s.lastInitError = null;
      console.error(
        `${LOG_PREFIX} Loaded ${s.merged.size} settings from Infisical ` +
          `(app ${appProjectId} [${appEnv}]` +
          `${sharedProjectId ? ` shadowing shared ${sharedProjectId} [${sharedEnv}]` : ""}).`
      );
      startRefreshTimer(s, refreshMs);
      installSighupHandler();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      s.lastInitError = message;
      // Fail-soft: the runner already injected the Infisical-sourced values into
      // process.env, so boot continues on that snapshot instead of taking the
      // trading box down over a settings-fetch hiccup.
      seedFromBootEnv(s, `Credentialed init failed (${message}); falling back.`);
    }
    s.initialized = true;
    return status();
  })();
  return host.__infisicalSettingsInitPromise;
}

/** Current service status — for the admin settings-reload route and diagnostics. */
export function infisicalSettingsStatus(): InfisicalSettingsStatus {
  return status();
}

function status(): InfisicalSettingsStatus {
  const s = state();
  return {
    initialized: s.initialized,
    credentialed: s.credentialed,
    keys: s.merged.size,
    lastRefreshAt: s.lastRefreshAt,
    lastInitError: s.lastInitError,
    refreshIntervalMs: s.refreshIntervalMs
  };
}

/**
 * Read a setting from the in-memory cache WITHOUT throwing when uninitialized:
 * returns the cache value when init() has run, otherwise the boot
 * process.env value (identical source — the runner injected it from Infisical).
 * Never touches the network.
 */
export function peekSetting(key: string): string | undefined {
  const s = state();
  if (s.initialized) return s.merged.get(key);
  return process.env[key];
}

/** Read from the in-memory cache.  Throws when init() has not run.  Never hits the network. */
export function getSetting(key: string): string | undefined {
  const s = state();
  if (!s.initialized) {
    throw new Error(`${LOG_PREFIX} call initInfisicalSettings() before reading settings`);
  }
  return s.merged.get(key);
}

/** Read from the cache, throwing a clear error (naming the key, pointing at INFISICAL.md) when absent. */
export function getRequiredSetting(key: string): string {
  const value = getSetting(key);
  if (value === undefined) {
    throw new Error(
      `${LOG_PREFIX} Missing required setting "${key}". Add it to the Infisical project and ` +
        `restart — see INFISICAL.md.`
    );
  }
  return value;
}

/** True when the key is present in the in-memory cache.  Never hits the network. */
export function hasSetting(key: string): boolean {
  const s = state();
  if (!s.initialized) {
    throw new Error(`${LOG_PREFIX} call initInfisicalSettings() before reading settings`);
  }
  return s.merged.has(key);
}

/**
 * Write-through save: persists to the APP Infisical project FIRST, then
 * updates the local cache.  Rejects with InfisicalWriteError (cache untouched)
 * when the Infisical write fails.  Rejects with a plain Error when this
 * process holds no Infisical credentials (production posture) — change the
 * value via the Infisical dashboard/CLI instead; see INFISICAL.md.
 */
export async function setSetting(key: string, value: string): Promise<void> {
  const s = state();
  if (!s.initialized) {
    throw new Error(`${LOG_PREFIX} call initInfisicalSettings() before writing settings`);
  }
  if (!s.credentialed || !s.app) {
    throw new Error(
      `${LOG_PREFIX} Write-through for "${key}" is unavailable: this process holds no ` +
        `universal-auth credentials (the secrets runner scrubs bootstrap credentials by design). ` +
        `Change the value via the Infisical dashboard or scripts/infisical-secrets-safe.sh — ` +
        `see INFISICAL.md.`
    );
  }
  await s.app.set(key, value);
  s.merged.set(key, value);
}

/**
 * On-demand refresh (SIGHUP handler, admin "Reload settings" action).
 * Never throws — returns a result; failures keep the last-known-good cache.
 */
export function refreshInfisicalSettings(): Promise<RefreshResult> {
  return refreshAll();
}

/** Clear the background timer and drop clients.  Call on shutdown / in tests. */
export function stopInfisicalSettings(): void {
  const host = globalThis as HostFlags;
  const s = state();
  if (host.__infisicalSettingsTimer) {
    clearInterval(host.__infisicalSettingsTimer);
    host.__infisicalSettingsTimer = undefined;
  }
  try {
    s.app?.stop();
  } catch {
    // ignore
  }
  try {
    s.shared?.stop();
  } catch {
    // ignore
  }
}

/** Test-only: drop all singleton state (including the init promise) so tests can re-init. */
export function __resetInfisicalSettingsForTests(): void {
  stopInfisicalSettings();
  const host = globalThis as HostFlags;
  host.__infisicalSettings = freshState();
  host.__infisicalSettingsInitPromise = null;
  host.__infisicalSettingsSighup = false;
}

export { InfisicalWriteError };
export type { InfisicalSettings };
