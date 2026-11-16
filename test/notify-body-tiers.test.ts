import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, setNotifyPrefs } from "../src/lib/db";
import { CHANNEL_CAPABILITIES, formatNotifyEmailText, notify, type NotifyConfig } from "../src/lib/notify";
import type { NotifyMessage } from "../src/lib/types";

// notify()'s bodyTiers (types.ts) lets a caller (currently only watchlist-digest.ts) hand every
// channel a pre-rendered body sized for that channel, instead of one body truncated the same way
// everywhere. notify() must pick the LARGEST tier that fits each channel's
// CHANNEL_CAPABILITIES.maxBodyChars cap, and a caller that never sets bodyTiers must see IDENTICAL
// behavior to before this feature existed.

const resolveHost = async () => ["8.8.8.8"]; // stub DNS for the webhook channel's egress guard

const cfg = (): NotifyConfig => ({
  timeoutMs: 1000,
  retryAttempts: 1,
  retryDelayMs: 0,
  push: { ntfyServer: "https://ntfy.example" },
  pushover: { pushoverToken: "pv-token" },
  email: { provider: "resend", resendKey: "rk_test", from: "alerts@example.com" },
  sms: { twilioSid: "AC1", twilioToken: "tok", twilioFrom: "+10000000000" }
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-notify-body-tiers-${Date.now()}.db`)}`;
  getDb();
});

/** Runs one notify() call with exactly ONE channel enabled and returns the raw request body the
 *  channel's fetchImpl received, so each channel's tier selection can be asserted in isolation. */
async function sendAndCapture(
  userId: string,
  channel: "push" | "pushover" | "webhook" | "email" | "sms",
  target: Record<string, string>,
  msg: NotifyMessage
): Promise<string> {
  setNotifyPrefs(userId, { channels: [channel], ...target });
  let captured = "";
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    captured = typeof init?.body === "string" ? init.body : "";
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const results = await notify(userId, msg, { config: cfg(), fetchImpl, resolveHost });
  expect(results[0]?.ok).toBe(true);
  return captured;
}

describe("notify() CHANNEL_CAPABILITIES", () => {
  it("matches the SMS channel's own existing 1500-char slice (kept in sync deliberately)", () => {
    expect(CHANNEL_CAPABILITIES.sms.maxBodyChars).toBe(1500);
  });
});

describe("notify() bodyTiers: largest-fitting-tier selection per channel", () => {
  // full exceeds push's 4000 cap; medium exceeds sms/pushover's caps but fits push; brief fits
  // every channel. Distinct repeating characters make each tier trivially distinguishable.
  const full = "F".repeat(5000);
  const medium = "M".repeat(3000);
  const brief = "B".repeat(500);
  const msg: NotifyMessage = { title: "T", body: full, kind: "watchlist_digest", bodyTiers: { full, medium, brief } };

  it("webhook (100000 cap): gets the full tier", async () => {
    const body = await sendAndCapture("tier-webhook", "webhook", { webhookUrl: "https://h.example/hook" }, msg);
    expect(JSON.parse(body).body).toBe(full);
  });

  it("email (100000 cap): gets the full tier", async () => {
    const body = await sendAndCapture("tier-email", "email", { email: "you@example.com" }, msg);
    expect(JSON.parse(body).text).toBe(formatNotifyEmailText(msg.title, full));
  });

  it("push (4000 cap): full doesn't fit, falls to medium", async () => {
    const body = await sendAndCapture("tier-push", "push", { pushTarget: "topic" }, msg);
    expect(body).toBe(medium);
  });

  it("pushover (1024 cap): full and medium don't fit, falls to brief", async () => {
    const body = await sendAndCapture("tier-pushover", "pushover", { pushoverTarget: "u1" }, msg);
    expect(new URLSearchParams(body).get("message")).toBe(brief);
  });

  it("sms (1500 cap): full and medium don't fit, falls to brief", async () => {
    const body = await sendAndCapture("tier-sms", "sms", { phone: "+14155551234" }, msg);
    expect(new URLSearchParams(body).get("Body")).toBe(`${msg.title}\n${brief}`);
  });

  it("falls back to the smallest available tier (then that channel's own truncation) when nothing fits", async () => {
    // brief itself exceeds pushover's 1024 cap here — nothing fits, so the smallest tier ships as-is.
    const oversizedBrief = "B".repeat(2000);
    const msgNothingFits: NotifyMessage = {
      title: "T",
      body: full,
      bodyTiers: { full, brief: oversizedBrief } // no medium
    };
    const body = await sendAndCapture("tier-nothing-fits", "pushover", { pushoverTarget: "u1" }, msgNothingFits);
    expect(new URLSearchParams(body).get("message")).toBe(oversizedBrief);
  });
});

describe("notify() without bodyTiers: existing single-body behavior is byte-for-byte unchanged", () => {
  it("webhook carries the full untruncated body (no notify.ts-side truncation)", async () => {
    const longBody = "X".repeat(2000);
    const body = await sendAndCapture("no-tiers-webhook", "webhook", { webhookUrl: "https://h.example/hook" }, {
      title: "T",
      body: longBody
    });
    expect(JSON.parse(body).body).toBe(longBody);
  });

  it("sms still applies its own pre-existing 1500-char slice, unaffected by bodyTiers logic", async () => {
    const longBody = "X".repeat(2000);
    const body = await sendAndCapture("no-tiers-sms", "sms", { phone: "+14155551234" }, { title: "T", body: longBody });
    const sent = new URLSearchParams(body).get("Body") ?? "";
    expect(sent.length).toBe(1500);
    expect(sent).toBe(`T\n${longBody}`.slice(0, 1500));
  });
});
