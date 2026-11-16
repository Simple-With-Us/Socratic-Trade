// Per-user delivery-channel credentials (owner directive 2026-07-31):
// Pushover app token + Twilio set live in user settings (encrypted at rest),
// win over server env, and make channels available without any server setup.
process.env.ENCRYPTION_KEY = "0".repeat(64);

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db";
import { getNotifyPrefs, getNotifyPrefsSecrets, setNotifyPrefs } from "../src/lib/db-api-keys";
import { loadNotifyConfig, loadUserNotifyConfig, notify } from "../src/lib/notify";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-notifycreds-${randomUUID()}.db`)}`;
});

const USER = "local";

beforeEach(() => {
  getDb().prepare("DELETE FROM notification_prefs WHERE user_id = ?").run(USER);
  delete process.env.PUSHOVER_APP_TOKEN;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM;
});

function rawColumn(name: string): string {
  const row = getDb().prepare(`SELECT ${name} AS v FROM notification_prefs WHERE user_id = ?`).get(USER) as { v: string } | undefined;
  return row?.v ?? "";
}

describe("migration v64 columns", () => {
  it("adds the four credential columns to notification_prefs", () => {
    setNotifyPrefs(USER, {});
    const cols = (getDb().pragma("table_info(notification_prefs)") as Array<{ name: string }>).map((c) => c.name);
    for (const col of ["pushover_app_token", "twilio_account_sid", "twilio_auth_token", "twilio_from"]) {
      expect(cols).toContain(col);
    }
  });
});

describe("setNotifyPrefs credential fields", () => {
  it("stores credentials encrypted, exposes presence flags only", () => {
    const prefs = setNotifyPrefs(USER, {
      pushoverAppToken: "app-token-123",
      twilioAccountSid: "AC123",
      twilioAuthToken: "tw-auth",
      twilioFrom: "+15550001111",
    });
    expect(prefs.pushoverAppTokenSet).toBe(true);
    expect(prefs.twilioAccountSidSet).toBe(true);
    expect(prefs.twilioAuthTokenSet).toBe(true);
    expect(prefs.twilioFromSet).toBe(true);
    // The prefs object (what the API serializes) must not contain the values.
    expect(JSON.stringify(prefs)).not.toContain("app-token-123");
    expect(JSON.stringify(prefs)).not.toContain("tw-auth");
    // At rest: ciphertext envelope, not plaintext.
    const raw = rawColumn("pushover_app_token");
    expect(raw).not.toBe("app-token-123");
    expect(raw.startsWith("v1:")).toBe(true);
  });

  it("decrypts round-trip via getNotifyPrefsSecrets", () => {
    setNotifyPrefs(USER, { pushoverAppToken: "app-token-123", twilioAuthToken: "tw-auth" });
    const secrets = getNotifyPrefsSecrets(USER);
    expect(secrets.pushoverAppToken).toBe("app-token-123");
    expect(secrets.twilioAuthToken).toBe("tw-auth");
    expect(secrets.twilioAccountSid).toBe("");
  });

  it("undefined keeps the stored value; empty string clears it", () => {
    setNotifyPrefs(USER, { pushoverAppToken: "app-token-123" });
    setNotifyPrefs(USER, { pushTarget: "ntfy-topic" }); // no pushoverAppToken key
    expect(getNotifyPrefsSecrets(USER).pushoverAppToken).toBe("app-token-123");
    setNotifyPrefs(USER, { pushoverAppToken: "" });
    expect(getNotifyPrefsSecrets(USER).pushoverAppToken).toBe("");
    expect(getNotifyPrefs(USER).pushoverAppTokenSet).toBe(false);
  });
});

describe("loadUserNotifyConfig", () => {
  it("user credentials win over server env", () => {
    process.env.PUSHOVER_APP_TOKEN = "env-token";
    setNotifyPrefs(USER, { pushoverAppToken: "user-token" });
    expect(loadUserNotifyConfig(USER).pushover.pushoverToken).toBe("user-token");
  });
  it("falls back to env when the user has no stored credential", () => {
    process.env.PUSHOVER_APP_TOKEN = "env-token";
    process.env.TWILIO_ACCOUNT_SID = "ACenv";
    expect(loadUserNotifyConfig(USER).pushover.pushoverToken).toBe("env-token");
    expect(loadUserNotifyConfig(USER).sms.twilioSid).toBe("ACenv");
  });
  it("empty everything yields empty credentials", () => {
    expect(loadUserNotifyConfig(USER).pushover.pushoverToken).toBe("");
    expect(loadUserNotifyConfig(USER).sms.twilioSid).toBe("");
  });
});

describe("notify() with per-user credentials", () => {
  it("delivers pushover using the user's app token when no env is set", async () => {
    setNotifyPrefs(USER, { channels: ["pushover"], pushoverTarget: "user-key-1", pushoverAppToken: "user-app-token" });
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const results = await notify(USER, { title: "t", body: "b" }, { fetchImpl });
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(calls[0].url).toContain("pushover.net");
    expect(calls[0].body).toContain("token=user-app-token");
    expect(calls[0].body).toContain("user=user-key-1");
  });

  it("delivers sms using the user's Twilio set when no env is set", async () => {
    setNotifyPrefs(USER, {
      channels: ["sms"],
      phone: "+15559998888",
      twilioAccountSid: "ACuser",
      twilioAuthToken: "tw-user",
      twilioFrom: "+15550001111",
    });
    const calls: Array<{ url: string; auth: string; body: string }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(url), auth: headers.authorization ?? "", body: String(init?.body ?? "") });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const results = await notify(USER, { title: "t", body: "b" }, { fetchImpl });
    expect(results[0].ok).toBe(true);
    expect(calls[0].url).toContain("/Accounts/ACuser/");
    expect(calls[0].auth).toBe(`Basic ${Buffer.from("ACuser:tw-user").toString("base64")}`);
    expect(calls[0].body).toContain("From=%2B15550001111");
    expect(calls[0].body).toContain("To=%2B15559998888");
  });

  it("skips pushover when neither user nor env credentials exist", async () => {
    setNotifyPrefs(USER, { channels: ["pushover"], pushoverTarget: "user-key-1" });
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const results = await notify(USER, { title: "t", body: "b" }, { fetchImpl });
    expect(results[0].ok).toBe(false);
    expect(results[0].skipped).toBe("not_configured");
  });

  it("an explicit deps.config still wins (existing test/durable-caller behavior)", async () => {
    setNotifyPrefs(USER, { channels: ["pushover"], pushoverTarget: "user-key-1", pushoverAppToken: "user-app-token" });
    const calls: string[] = [];
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      calls.push(String(init?.body ?? ""));
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = { ...loadNotifyConfig(), pushover: { pushoverToken: "deps-token" } };
    const results = await notify(USER, { title: "t", body: "b" }, { fetchImpl, config: cfg });
    expect(results[0].ok).toBe(true);
    expect(calls[0]).toContain("token=deps-token");
  });
});
