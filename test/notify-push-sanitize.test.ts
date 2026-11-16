import { beforeAll, describe, expect, it } from "vitest";
import { getDb, setNotifyPrefs } from "../src/lib/db";
import { notify, type NotifyConfig } from "../src/lib/notify";
import { sanitizePushHeaderText } from "../src/lib/notifications";

// Regression coverage for a real prod bug: the ntfy push channel (notify.ts's CHANNELS.push.send)
// carries the alert TITLE as a raw HTTP header value. The Fetch/Headers spec requires header
// values to be ByteString (Latin-1 only) -- an em dash (U+2014, code point 8212) or similar
// character in the title throws `TypeError: Cannot convert argument to a ByteString` at send time,
// silently dropping the whole push notification (recorded only as a `notify.error` audit row).
// Observed in prod on provider-health alert strings that used an em dash.

describe("sanitizePushHeaderText (notifications.ts)", () => {
  it("round-trips a plain ASCII message unchanged", () => {
    expect(sanitizePushHeaderText("Red Team review unavailable")).toBe("Red Team review unavailable");
  });

  it("transliterates an em dash to a plain hyphen", () => {
    expect(sanitizePushHeaderText("Alert — outage")).toBe("Alert - outage");
  });

  it("transliterates an en dash to a plain hyphen", () => {
    expect(sanitizePushHeaderText("pages 1–5")).toBe("pages 1-5");
  });

  it("transliterates an ellipsis to three dots", () => {
    expect(sanitizePushHeaderText("Loading… done")).toBe("Loading... done");
  });

  it("transliterates a rightwards arrow to '->'", () => {
    expect(sanitizePushHeaderText("A → B")).toBe("A -> B");
  });

  it("transliterates curly quotes to straight quotes", () => {
    expect(sanitizePushHeaderText("“quoted” and ‘single’")).toBe('"quoted" and \'single\'');
  });

  it("strips any remaining non-Latin-1 character (e.g. emoji) instead of leaving it in place", () => {
    expect(sanitizePushHeaderText("Deploy ✅ done")).toBe("Deploy  done");
  });

  it("is a no-op on empty string", () => {
    expect(sanitizePushHeaderText("")).toBe("");
  });

  it("the sanitized output never throws when used as a real Headers value, while the raw text does", () => {
    const raw = "Red Team (inline Bear) review unavailable — routed to human review";
    expect(() => new Headers({ title: raw })).toThrowError(/ByteString/);

    const sanitized = sanitizePushHeaderText(raw);
    expect(() => new Headers({ title: sanitized })).not.toThrow();
    expect(sanitized).toBe("Red Team (inline Bear) review unavailable - routed to human review");
  });
});

describe("notify() push (ntfy) channel survives an em-dash title", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/notify-push-sanitize-${Date.now()}.db`;
    getDb();
  });

  const cfg = (): NotifyConfig => ({
    timeoutMs: 1000,
    retryAttempts: 1,
    retryDelayMs: 0,
    push: { ntfyServer: "https://ntfy.example" },
    pushover: { pushoverToken: "" },
    email: { provider: "resend", resendKey: "", from: "" },
    sms: { twilioSid: "", twilioToken: "", twilioFrom: "" }
  });

  it("delivers successfully and the header value it actually sends is ByteString-safe", async () => {
    setNotifyPrefs("push-em-dash-user", { channels: ["push"], pushTarget: "alerts-test-topic" });

    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      // Mirrors the real Fetch API: constructing Headers from a non-Latin-1 value throws here,
      // exactly like it would inside real undici/browser fetch.
      const headers = new Headers(init?.headers as Record<string, string>);
      capturedHeaders = Object.fromEntries(headers.entries());
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const emDashTitle = "provider_degraded — Pinecone connection failed";
    const results = await notify(
      "push-em-dash-user",
      { title: emDashTitle, body: "details here", kind: "provider_degraded" },
      { config: cfg(), fetchImpl }
    );

    const pushResult = results.find((r) => r.channel === "push");
    expect(pushResult?.ok).toBe(true);
    expect(capturedHeaders?.title).toBe("provider_degraded - Pinecone connection failed");
  });
});
