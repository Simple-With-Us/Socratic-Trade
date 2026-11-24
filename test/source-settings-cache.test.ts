// ST-4643 (audit F5): the resolved per-user source-settings map is TTL-cached and invalidated
// on every write.
//
// Before: every `resolveSourceBool/Number/String` did a fresh `getUserSetting` point-SELECT
// plus a `JSON.parse` of the WHOLE map — 44 call sites, several inside provider `enrich()`
// calls on the scan and quote hot paths.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-source-settings-cache-${randomUUID()}.db`)}`;

import { setUserSetting } from "../src/lib/db-settings";
import {
  SOURCE_SETTINGS_CACHE_TTL_MS,
  SOURCE_SETTINGS_USER_KEY,
  getUserSourceSettingsMap,
  invalidateSourceSettingsCache,
  resolveSourceBool,
  setUserSourceSettingsMap
} from "../src/lib/source-settings";

const USER = "cache-user";

beforeEach(() => {
  invalidateSourceSettingsCache();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-23T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  invalidateSourceSettingsCache();
  // Restore the shared config this file mutated.  `getDb()` memoizes its connection, so the
  // already-open handle keeps pointing at this file's temp database for the rest of the file.
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

describe("source settings TTL cache (ST-4643 / audit F5)", () => {
  it("serves a repeated read from the cache instead of re-reading the store", () => {
    setUserSourceSettingsMap(USER, { WEB_SOURCE_SEC8K: true });
    expect(getUserSourceSettingsMap(USER)).toEqual({ WEB_SOURCE_SEC8K: true });

    // Change the store WITHOUT going through the write helper (another process, an admin
    // route, a migration).  Inside the TTL the cached copy is served.
    setUserSetting(USER, SOURCE_SETTINGS_USER_KEY, { WEB_SOURCE_SEC8K: false });
    expect(getUserSourceSettingsMap(USER)).toEqual({ WEB_SOURCE_SEC8K: true });

    // After the TTL the cache is refreshed and the new value is visible.
    vi.setSystemTime(new Date(Date.now() + SOURCE_SETTINGS_CACHE_TTL_MS + 1));
    expect(getUserSourceSettingsMap(USER)).toEqual({ WEB_SOURCE_SEC8K: false });
  });

  it("invalidates the cache on every write, so a change is visible immediately", () => {
    setUserSourceSettingsMap(USER, { WEB_SOURCE_SEC8K: true });
    expect(resolveSourceBool("WEB_SOURCE_SEC8K", USER)).toBe(true);

    setUserSourceSettingsMap(USER, { WEB_SOURCE_SEC8K: false });
    expect(resolveSourceBool("WEB_SOURCE_SEC8K", USER)).toBe(false);
    expect(getUserSourceSettingsMap(USER)).toEqual({ WEB_SOURCE_SEC8K: false });
  });

  it("keeps the cache per user", () => {
    setUserSourceSettingsMap("user-a", { WEB_SOURCE_SEC8K: true });
    setUserSourceSettingsMap("user-b", { WEB_SOURCE_SEC8K: false });
    expect(getUserSourceSettingsMap("user-a")).toEqual({ WEB_SOURCE_SEC8K: true });
    expect(getUserSourceSettingsMap("user-b")).toEqual({ WEB_SOURCE_SEC8K: false });
  });
});
