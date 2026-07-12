import { beforeAll, describe, expect, it } from "vitest";
import { getDb, getNotifyPrefs, setNotifyPrefs } from "../src/lib/db";
import { describeChannels, notify, type NotifyConfig } from "../src/lib/notify";

const baseCfg = (): NotifyConfig => ({
  timeoutMs: 1000,
  push: { provider: "ntfy", ntfyServer: "https://ntfy.example", pushoverToken: "" },
  email: { provider: "resend", resendKey: "rk_test", from: "alerts@example.com" },
  sms: { twilioSid: "AC1", twilioToken: "tok", twilioFrom: "+10000000000" }
});

describe("notify multi-channel delivery", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/notify-test-${Date.now()}.db`;
    getDb();
  });

  it("prefs round-trip: channels filtered to known set, targets trimmed", () => {
    const saved = setNotifyPrefs("u1", {
      channels: ["webhook", "bogus", "sms"],
      webhookUrl: "  https://h.example/x  ",
      phone: " +14155551234 "
    });
    expect([...saved.channels].sort()).toEqual(["sms", "webhook"]);
    expect(saved.webhookUrl).toBe("https://h.example/x");
    expect(saved.phone).toBe("+14155551234");
    expect([...getNotifyPrefs("u1").channels].sort()).toEqual(["sms", "webhook"]);
  });

  it("delivers to each enabled channel that has a target; records targetless skips", async () => {
    setNotifyPrefs("u2", {
      channels: ["webhook", "email", "sms", "push"],
      webhookUrl: "https://h.example/hook",
      email: "you@example.com",
      phone: "+14155551234"
    });
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const results = await notify("u2", { title: "T", body: "B", kind: "price_alert" }, { config: baseCfg(), fetchImpl });
    const byChannel = Object.fromEntries(results.map((r) => [r.channel, r]));
    expect(byChannel.webhook?.ok).toBe(true);
    expect(byChannel.email?.ok).toBe(true);
    expect(byChannel.sms?.ok).toBe(true);
    expect(byChannel.push?.skipped).toBe("no_target");
    expect(calls.length).toBe(3);
  });

  it("records a channel failure without throwing", async () => {
    setNotifyPrefs("u3", { channels: ["webhook"], webhookUrl: "https://h.example/hook" });
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const results = await notify("u3", { title: "T", body: "B" }, { config: baseCfg(), fetchImpl });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toContain("HTTP 500");
  });

  it("describeChannels reflects admin availability", () => {
    const cfg = baseCfg();
    expect(describeChannels(cfg).find((c) => c.id === "sms")?.available).toBe(true);
    const noSms = describeChannels({ ...cfg, sms: { twilioSid: "", twilioToken: "", twilioFrom: "" } });
    expect(noSms.find((c) => c.id === "sms")?.available).toBe(false);
  });
});
