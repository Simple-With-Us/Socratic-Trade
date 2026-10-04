/**
 * Infisical SOT settings service (src/lib/infisical-settings.ts) + knob write-through
 * (src/lib/server-knobs.ts writeServerKnobThrough):
 *
 *   - startup load populates the cache (shared-first, app-shadows merge)
 *   - runtime reads make zero network calls after init
 *   - write-through: the Infisical persist happens BEFORE the cache update
 *   - failed refresh keeps serving last-known-good
 *   - failed write-through rejects and leaves the cache untouched
 *   - uncredentialed init seeds from the boot env and refuses writes loudly
 *   - knob flips via writeServerKnobThrough() persist to Infisical before the DB override
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  __resetInfisicalSettingsForTests,
  getRequiredSetting,
  getSetting,
  hasSetting,
  infisicalSettingsStatus,
  initInfisicalSettings,
  peekSetting,
  refreshInfisicalSettings,
  setSetting,
  stopInfisicalSettings,
  InfisicalWriteError
} from "../src/lib/infisical-settings";
import {
  invalidateServerKnobCache,
  resolveServerKnob,
  serverKnobOverride,
  SERVER_KNOBS_SETTING_KEY,
  writeServerKnobThrough
} from "../src/lib/server-knobs";
import { setInternalSetting } from "../src/lib/db";

const APP_PROJ = "app-proj-id";
const SHARED_PROJ = "shared-proj-id";

interface MockLog {
  ops: string[];
  /** projectId -> key -> value */
  secrets: Map<string, Map<string, string>>;
  failLogin: boolean;
  failGet: boolean;
  failPatch: boolean;
  /** value the settings cache held for PROBE_KEY while a PATCH was in flight (ordering probe) */
  cacheDuringPatch: string | undefined;
}

function freshLog(): MockLog {
  return {
    ops: [],
    secrets: new Map(),
    failLogin: false,
    failGet: false,
    failPatch: false,
    cacheDuringPatch: undefined
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

const PROBE_KEY = "STREAMS_ALPACA_NEWS_ENABLED";

function makeFetch(log: MockLog): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (u.endsWith("/api/v1/auth/universal-auth/login") && method === "POST") {
      log.ops.push("login");
      if (log.failLogin) throw new Error("login down");
      return json({ accessToken: "test-token", expiresIn: 3600 });
    }
    if (u.includes("/api/v3/secrets/raw?")) {
      const qs = new URL(u).searchParams;
      const ws = qs.get("workspaceId") ?? "";
      log.ops.push(`get:${ws === APP_PROJ ? "app" : ws === SHARED_PROJ ? "shared" : ws}`);
      if (log.failGet) return new Response("boom", { status: 500 });
      const store = log.secrets.get(ws) ?? new Map<string, string>();
      return json({
        secrets: [...store.entries()].map(([secretKey, secretValue]) => ({ secretKey, secretValue }))
      });
    }
    const m = u.match(/\/api\/v3\/secrets\/raw\/([^/?]+)$/);
    if (m) {
      const key = decodeURIComponent(m[1]);
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        workspaceId: string;
        secretValue: string;
      };
      const store = log.secrets.get(body.workspaceId) ?? new Map<string, string>();
      log.secrets.set(body.workspaceId, store);
      if (method === "PATCH") {
        log.ops.push(`patch:${key}`);
        // Ordering probe: the cache must NOT reflect the new value while the
        // Infisical persist is still in flight (write-through = Infisical first).
        log.cacheDuringPatch = getSetting(key);
        if (log.failPatch) return new Response("nope", { status: 500 });
        if (!store.has(key)) return new Response("nf", { status: 404 });
        store.set(key, body.secretValue);
        return json({ secret: { secretKey: key } });
      }
      if (method === "POST") {
        log.ops.push(`post:${key}`);
        if (log.failPatch) return new Response("nope", { status: 500 });
        store.set(key, body.secretValue);
        return json({ secret: { secretKey: key } });
      }
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  }) as typeof fetch;
}

function credentialedOptions(log: MockLog, refreshIntervalMs = 0) {
  return {
    clientId: "test-id",
    clientSecret: "test-secret",
    appProjectId: APP_PROJ,
    appEnvironment: "dev",
    sharedProjectId: SHARED_PROJ,
    sharedEnvironment: "dev",
    refreshIntervalMs,
    fetchImpl: makeFetch(log)
  };
}

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `sot-infisical-settings-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  __resetInfisicalSettingsForTests();
  invalidateServerKnobCache();
  setInternalSetting(SERVER_KNOBS_SETTING_KEY, {});
  for (const id of ["STREAMS_ALPACA_NEWS_ENABLED", "SEC_INGEST_WORKER_ENABLED"]) delete process.env[id];
  delete process.env.INFISICAL_CLIENT_ID;
  delete process.env.INFISICAL_CLIENT_SECRET;
  delete process.env.SOT_TEST_SEED;
});

afterEach(() => {
  stopInfisicalSettings();
  __resetInfisicalSettingsForTests();
  invalidateServerKnobCache();
  setInternalSetting(SERVER_KNOBS_SETTING_KEY, {});
  for (const id of ["STREAMS_ALPACA_NEWS_ENABLED", "SEC_INGEST_WORKER_ENABLED"]) delete process.env[id];
  delete process.env.SOT_TEST_SEED;
});

describe("init: startup load populates the cache (shared-first, app-shadows)", () => {
  it("merges shared then app, with the app project winning overlaps", async () => {
    const log = freshLog();
    log.secrets.set(SHARED_PROJ, new Map([["SHARED_ONLY", "s1"], ["BOTH", "shared-wins-no"]]));
    log.secrets.set(APP_PROJ, new Map([["BOTH", "app-wins"], ["APP_ONLY", "a1"]]));
    const status = await initInfisicalSettings(credentialedOptions(log));
    expect(status.credentialed).toBe(true);
    expect(status.keys).toBe(3);
    expect(getSetting("SHARED_ONLY")).toBe("s1");
    expect(getSetting("BOTH")).toBe("app-wins");
    expect(getSetting("APP_ONLY")).toBe("a1");
    expect(hasSetting("BOTH")).toBe(true);
    expect(hasSetting("NOPE")).toBe(false);
    expect(getRequiredSetting("APP_ONLY")).toBe("a1");
    expect(() => getRequiredSetting("MISSING")).toThrow(/INFISICAL\.md/);
  });

  it("works app-only when no shared project is configured", async () => {
    const log = freshLog();
    log.secrets.set(APP_PROJ, new Map([["K", "v"]]));
    await initInfisicalSettings({ ...credentialedOptions(log), sharedProjectId: null });
    expect(getSetting("K")).toBe("v");
    expect(log.ops.filter((o) => o.startsWith("get:shared")).length).toBe(0);
  });
});

describe("reads: zero network calls after init", () => {
  it("get/getAll/has/peek/status never touch fetch once loaded", async () => {
    const log = freshLog();
    log.secrets.set(APP_PROJ, new Map([["K", "v"]]));
    await initInfisicalSettings(credentialedOptions(log));
    const opsAfterInit = log.ops.length;
    expect(opsAfterInit).toBeGreaterThan(0);
    getSetting("K");
    peekSetting("K");
    hasSetting("K");
    infisicalSettingsStatus();
    expect(log.ops.length).toBe(opsAfterInit);
  });
});

describe("write-through: Infisical first, then cache", () => {
  it("persists to Infisical before the cache reflects the new value", async () => {
    const log = freshLog();
    log.secrets.set(APP_PROJ, new Map([[PROBE_KEY, "false"]]));
    await initInfisicalSettings(credentialedOptions(log));
    expect(getSetting(PROBE_KEY)).toBe("false");
    await setSetting(PROBE_KEY, "true");
    // During the PATCH the cache still held the OLD value — Infisical won the race.
    expect(log.cacheDuringPatch).toBe("false");
    expect(log.ops).toContain(`patch:${PROBE_KEY}`);
    expect(getSetting(PROBE_KEY)).toBe("true");
    expect(log.secrets.get(APP_PROJ)?.get(PROBE_KEY)).toBe("true");
  });

  it("creates the secret with POST when it does not exist yet (PATCH 404)", async () => {
    const log = freshLog();
    await initInfisicalSettings(credentialedOptions(log));
    await setSetting("BRAND_NEW_KEY", "1");
    expect(log.ops).toContain("patch:BRAND_NEW_KEY");
    expect(log.ops).toContain("post:BRAND_NEW_KEY");
    expect(getSetting("BRAND_NEW_KEY")).toBe("1");
  });

  it("a failed Infisical write rejects and leaves the cache untouched", async () => {
    const log = freshLog();
    log.secrets.set(APP_PROJ, new Map([[PROBE_KEY, "false"]]));
    await initInfisicalSettings(credentialedOptions(log));
    log.failPatch = true;
    await expect(setSetting(PROBE_KEY, "true")).rejects.toBeInstanceOf(InfisicalWriteError);
    expect(getSetting(PROBE_KEY)).toBe("false");
  });
});

describe("refresh: failures keep last-known-good", () => {
  it("serves the old cache after a failed refresh", async () => {
    const log = freshLog();
    log.secrets.set(APP_PROJ, new Map([["K", "v1"]]));
    await initInfisicalSettings(credentialedOptions(log));
    // Infisical-side change…
    log.secrets.get(APP_PROJ)!.set("K", "v2");
    const ok = await refreshInfisicalSettings();
    expect(ok.refreshed).toBe(true);
    expect(getSetting("K")).toBe("v2");
    // …then the API breaks: refresh reports failure, cache stays at v2.
    log.failGet = true;
    const bad = await refreshInfisicalSettings();
    expect(bad.refreshed).toBe(false);
    expect(bad.reason).toBe("error");
    expect(getSetting("K")).toBe("v2");
  });
});

describe("uncredentialed mode: boot-env seed, loud refusal to write", () => {
  it("seeds the cache from the runner-injected boot env and refuses writes", async () => {
    process.env.SOT_TEST_SEED = "seeded-value";
    const status = await initInfisicalSettings({ refreshIntervalMs: 0 });
    expect(status.initialized).toBe(true);
    expect(status.credentialed).toBe(false);
    expect(getSetting("SOT_TEST_SEED")).toBe("seeded-value");
    await expect(setSetting("SOT_TEST_SEED", "x")).rejects.toThrow(/no universal-auth credentials/);
    const r = await refreshInfisicalSettings();
    expect(r).toMatchObject({ refreshed: false, reason: "uncredentialed" });
  });

  it("a failed credentialed init falls back to the boot env instead of throwing", async () => {
    process.env.SOT_TEST_SEED = "fallback-value";
    const log = freshLog();
    log.failLogin = true;
    const status = await initInfisicalSettings(credentialedOptions(log));
    expect(status.credentialed).toBe(false);
    expect(status.lastInitError).toMatch(/universal-auth login request failed/);
    expect(getSetting("SOT_TEST_SEED")).toBe("fallback-value");
  });
});

describe("knob write-through (server-knobs integration)", () => {
  it("writes Infisical first, then the DB override; failure leaves the DB untouched", async () => {
    const log = freshLog();
    await initInfisicalSettings(credentialedOptions(log));
    const res = await writeServerKnobThrough("STREAMS_ALPACA_NEWS_ENABLED", true);
    expect(res).toEqual({ infisicalWriteThrough: true });
    expect(log.ops).toContain("post:STREAMS_ALPACA_NEWS_ENABLED");
    expect(serverKnobOverride("STREAMS_ALPACA_NEWS_ENABLED")).toBe(true);
    expect(resolveServerKnob("STREAMS_ALPACA_NEWS_ENABLED")).toBe(true);
  });

  it("a failed Infisical write fails the save — no DB override is written", async () => {
    const log = freshLog();
    await initInfisicalSettings(credentialedOptions(log));
    log.failPatch = true;
    await expect(writeServerKnobThrough("STREAMS_ALPACA_NEWS_ENABLED", true)).rejects.toBeInstanceOf(
      InfisicalWriteError
    );
    expect(serverKnobOverride("STREAMS_ALPACA_NEWS_ENABLED")).toBeUndefined();
    expect(resolveServerKnob("STREAMS_ALPACA_NEWS_ENABLED")).toBe(false);
  });

  it("uncredentialed saves still land the DB override and report honestly", async () => {
    await initInfisicalSettings({ refreshIntervalMs: 0 });
    const res = await writeServerKnobThrough("STREAMS_ALPACA_NEWS_ENABLED", true);
    expect(res).toEqual({ infisicalWriteThrough: false });
    expect(serverKnobOverride("STREAMS_ALPACA_NEWS_ENABLED")).toBe(true);
  });

  it("clearing (null) clears only the DB override, leaving Infisical alone", async () => {
    const log = freshLog();
    await initInfisicalSettings(credentialedOptions(log));
    await writeServerKnobThrough("STREAMS_ALPACA_NEWS_ENABLED", true);
    const opsAfterSet = log.ops.length;
    const res = await writeServerKnobThrough("STREAMS_ALPACA_NEWS_ENABLED", null);
    expect(res).toEqual({ infisicalWriteThrough: false });
    expect(log.ops.length).toBe(opsAfterSet); // no Infisical call on clear
    expect(serverKnobOverride("STREAMS_ALPACA_NEWS_ENABLED")).toBeUndefined();
  });

  it("the live cache is preferred over a stale boot env", async () => {
    const log = freshLog();
    log.secrets.set(APP_PROJ, new Map([["SEC_INGEST_WORKER_ENABLED", "false"]]));
    process.env.SEC_INGEST_WORKER_ENABLED = "true"; // stale boot injection
    await initInfisicalSettings(credentialedOptions(log));
    expect(resolveServerKnob("SEC_INGEST_WORKER_ENABLED")).toBe(false);
  });
});
