// Out-of-app delivery for triggered alerts (and any future server-originated notice). Pluggable
// channels — phone push (ntfy/Pushover), webhook, email (Resend), SMS (Twilio) — each gated by
// admin config (server env) except webhook, which only needs a user-supplied URL. The user picks
// channels + per-channel targets in Settings (notification_prefs table); the dispatcher delivers to
// every enabled channel that is both admin-available and has a target. All network calls go through
// an injectable `fetchImpl` so tests stay offline. Ported from reference/atlas-public-src/bff/notify.

import { audit, getNotifyPrefs } from "./db";
import type {
  NotifyChannelDescriptor,
  NotifyChannelId,
  NotifyChannelResult,
  NotifyMessage,
  NotifyPrefs
} from "./types";

export interface NotifyConfig {
  timeoutMs: number;
  push: { provider: "ntfy" | "pushover"; ntfyServer: string; pushoverToken: string };
  email: { provider: "resend"; resendKey: string; from: string };
  sms: { twilioSid: string; twilioToken: string; twilioFrom: string };
}

/** Admin-side delivery config from env. End-user secrets never live here — only in notification_prefs. */
export function loadNotifyConfig(): NotifyConfig {
  const provider = process.env.NOTIFY_PUSH_PROVIDER === "pushover" ? "pushover" : "ntfy";
  const timeoutMs = Number(process.env.NOTIFY_TIMEOUT_MS ?? 5000);
  return {
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000,
    push: {
      provider,
      ntfyServer: process.env.NOTIFY_NTFY_SERVER ?? "https://ntfy.sh",
      pushoverToken: process.env.PUSHOVER_APP_TOKEN ?? ""
    },
    email: {
      provider: "resend",
      resendKey: process.env.RESEND_API_KEY ?? "",
      from: process.env.NOTIFY_EMAIL_FROM ?? ""
    },
    sms: {
      twilioSid: process.env.TWILIO_ACCOUNT_SID ?? "",
      twilioToken: process.env.TWILIO_AUTH_TOKEN ?? "",
      twilioFrom: process.env.TWILIO_FROM ?? ""
    }
  };
}

interface ChannelDef {
  available(cfg: NotifyConfig): boolean;
  target(prefs: NotifyPrefs): string;
  describe(cfg: NotifyConfig): NotifyChannelDescriptor;
  send(target: string, msg: NotifyMessage, ctx: { cfg: NotifyConfig; fetchImpl: typeof fetch; timeoutMs: number }): Promise<void>;
}

function abortSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

async function postOrThrow(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const res = await fetchImpl(url, { ...init, signal: abortSignal(timeoutMs) });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${detail ? ": " + detail.slice(0, 200) : ""}`);
  }
  return res;
}

const CHANNELS: Record<NotifyChannelId, ChannelDef> = {
  webhook: {
    available: () => true,
    target: (p) => p.webhookUrl || "",
    describe: () => ({
      id: "webhook",
      label: "Webhook",
      available: true,
      targetField: "webhookUrl",
      targetLabel: "Webhook URL",
      placeholder: "https://example.com/hooks/alerts",
      hint: "We POST a JSON payload here when an alert fires."
    }),
    async send(url, msg, { fetchImpl, timeoutMs }) {
      if (!/^https:\/\//i.test(url)) throw new Error("webhook URL must be https");
      await postOrThrow(
        fetchImpl,
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "SocraticTrade-Alerts/1" },
          body: JSON.stringify({
            source: "socratic-trade",
            kind: msg.kind ?? "alert",
            title: msg.title,
            body: msg.body,
            data: msg.data ?? null,
            sent_at: new Date().toISOString()
          })
        },
        timeoutMs
      );
    }
  },

  push: {
    available: (cfg) => cfg.push.provider === "ntfy" || (cfg.push.provider === "pushover" && !!cfg.push.pushoverToken),
    target: (p) => p.pushTarget || "",
    describe: (cfg) => {
      const isPushover = cfg.push.provider === "pushover";
      return {
        id: "push",
        label: "Phone push",
        available: CHANNELS.push.available(cfg),
        provider: cfg.push.provider,
        targetField: "pushTarget",
        targetLabel: isPushover ? "Pushover user key" : "ntfy topic",
        placeholder: isPushover ? "u1a2b3c4d5..." : "alerts-yourname-7c3f",
        hint: isPushover
          ? "Install Pushover, then paste your user key. Notices arrive on your phone."
          : `Free — no key needed. Install the ntfy app, subscribe to a hard-to-guess topic, then paste that exact topic here (server: ${cfg.push.ntfyServer}).`
      };
    },
    async send(target, msg, { cfg, fetchImpl, timeoutMs }) {
      if (cfg.push.provider === "pushover") {
        const form = new URLSearchParams({ token: cfg.push.pushoverToken, user: target, title: msg.title, message: msg.body });
        await postOrThrow(
          fetchImpl,
          "https://api.pushover.net/1/messages.json",
          { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() },
          timeoutMs
        );
      } else {
        const base = cfg.push.ntfyServer.replace(/\/+$/, "");
        const topic = encodeURIComponent(target.replace(/^\/+/, ""));
        await postOrThrow(
          fetchImpl,
          `${base}/${topic}`,
          { method: "POST", headers: { "content-type": "text/plain", title: msg.title }, body: msg.body },
          timeoutMs
        );
      }
    }
  },

  email: {
    available: (cfg) => cfg.email.provider === "resend" && !!cfg.email.resendKey && !!cfg.email.from,
    target: (p) => p.email || "",
    describe: (cfg) => ({
      id: "email",
      label: "Email",
      available: CHANNELS.email.available(cfg),
      targetField: "email",
      targetLabel: "Email address",
      placeholder: "you@example.com",
      hint: "Alerts are emailed to this address."
    }),
    async send(to, msg, { cfg, fetchImpl, timeoutMs }) {
      await postOrThrow(
        fetchImpl,
        "https://api.resend.com/emails",
        {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.email.resendKey}`, "content-type": "application/json" },
          body: JSON.stringify({ from: cfg.email.from, to: [to], subject: msg.title, text: msg.body })
        },
        timeoutMs
      );
    }
  },

  sms: {
    available: (cfg) => !!cfg.sms.twilioSid && !!cfg.sms.twilioToken && !!cfg.sms.twilioFrom,
    target: (p) => p.phone || "",
    describe: (cfg) => ({
      id: "sms",
      label: "SMS",
      available: CHANNELS.sms.available(cfg),
      targetField: "phone",
      targetLabel: "Mobile number",
      placeholder: "+14155551234",
      hint: "Standard carrier message rates may apply."
    }),
    async send(to, msg, { cfg, fetchImpl, timeoutMs }) {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.sms.twilioSid)}/Messages.json`;
      const authToken = Buffer.from(`${cfg.sms.twilioSid}:${cfg.sms.twilioToken}`).toString("base64");
      const form = new URLSearchParams({ From: cfg.sms.twilioFrom, To: to, Body: `${msg.title}\n${msg.body}`.slice(0, 1500) });
      await postOrThrow(
        fetchImpl,
        url,
        { method: "POST", headers: { authorization: `Basic ${authToken}`, "content-type": "application/x-www-form-urlencoded" }, body: form.toString() },
        timeoutMs
      );
    }
  }
};

const CHANNEL_ORDER: NotifyChannelId[] = ["push", "webhook", "email", "sms"];

/** UI metadata: which channels exist, which are admin-usable, and the target each needs. */
export function describeChannels(cfg: NotifyConfig = loadNotifyConfig()): NotifyChannelDescriptor[] {
  return CHANNEL_ORDER.map((id) => CHANNELS[id].describe(cfg));
}

/**
 * Deliver `msg` to every channel the user enabled that is both admin-available and has a target.
 * Returns a per-channel result list and never throws — a failing channel is recorded, others run.
 */
export async function notify(
  userId: string,
  msg: NotifyMessage,
  deps: { config?: NotifyConfig; fetchImpl?: typeof fetch; prefs?: NotifyPrefs } = {}
): Promise<NotifyChannelResult[]> {
  const cfg = deps.config ?? loadNotifyConfig();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const prefs = deps.prefs ?? getNotifyPrefs(userId);
  const results: NotifyChannelResult[] = [];
  for (const id of prefs.channels ?? []) {
    const channel = CHANNELS[id];
    if (!channel.available(cfg)) {
      results.push({ channel: id, ok: false, skipped: "not_configured" });
      continue;
    }
    const target = channel.target(prefs);
    if (!target) {
      results.push({ channel: id, ok: false, skipped: "no_target" });
      continue;
    }
    try {
      await channel.send(target, msg, { cfg, fetchImpl, timeoutMs: cfg.timeoutMs });
      results.push({ channel: id, ok: true });
      audit("notify.sent", { userId, channel: id, kind: msg.kind ?? "alert" }, userId);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      results.push({ channel: id, ok: false, error });
      audit("notify.error", { userId, channel: id, error }, userId);
    }
  }
  return results;
}
