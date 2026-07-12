import { audit, getNotifyPrefs, getPolicy, insertNotificationEvent } from "./db";
import { notify } from "./notify";
import type { NotificationEvent, NotificationEventType, TradingPolicy } from "./types";

type Fetcher = typeof fetch;
const DIRECT_NOTIFY_ALREADY_SENT = new Set<NotificationEventType>(["price_alert", "provider_degraded"]);

export async function sendNotification(
  input: {
    type: NotificationEventType;
    title: string;
    payload: unknown;
  },
  options: { policy?: TradingPolicy; fetcher?: Fetcher; timeoutMs?: number; userId?: string } = {}
): Promise<NotificationEvent> {
  const userId = options.userId ?? "local";
  const policy = options.policy ?? getPolicy(userId);
  const settings = policy.notificationSettings;
  const webhookUrl = settings.webhookUrl?.trim();

  if (!settings.enabledEvents.includes(input.type)) {
    return record(input, "skipped", webhookUrl, "Notification type is disabled.", userId, policy.connectedAccountId);
  }

  await sendDirectNotification(input, userId, { skipWebhook: !!webhookUrl });

  if (!webhookUrl) {
    return record(input, "skipped", undefined, "Notifications Webhook Not Configured", userId, policy.connectedAccountId);
  }

  const isDiscord = webhookUrl.includes("discord.com/api/webhooks") || webhookUrl.includes("discordapp.com/api/webhooks");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);

  try {
    const payloadBody = isDiscord
      ? formatDiscordPayload(input)
      : {
          type: input.type,
          title: input.title,
          payload: input.payload,
          createdAt: new Date().toISOString()
        };

    const response = await (options.fetcher ?? fetch)(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payloadBody),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) {
      return record(input, "failed", webhookUrl, `Webhook returned HTTP ${response.status}.`, userId, policy.connectedAccountId);
    }
    return record(input, "sent", webhookUrl, undefined, userId, policy.connectedAccountId);
  } catch (error) {
    clearTimeout(timeout);
    return record(input, "failed", webhookUrl, error instanceof Error ? error.message : "Webhook request failed.", userId, policy.connectedAccountId);
  }
}

async function sendDirectNotification(
  input: { type: NotificationEventType; title: string; payload: unknown },
  userId: string,
  options: { skipWebhook?: boolean } = {}
): Promise<void> {
  if (DIRECT_NOTIFY_ALREADY_SENT.has(input.type)) return;
  try {
    const prefs = options.skipWebhook
      ? (() => {
          const current = getNotifyPrefs(userId);
          return { ...current, channels: current.channels.filter((channel) => channel !== "webhook") };
        })()
      : undefined;
    await notify(
      userId,
      {
        title: input.title,
        body: directNotificationBody(input),
        kind: input.type,
        data: input.payload
      },
      prefs ? { prefs } : {}
    );
  } catch (error) {
    audit(
      "notify.bridge.error",
      {
        userId,
        type: input.type,
        error: error instanceof Error ? error.message : String(error)
      },
      userId
    );
  }
}

function directNotificationBody(input: { type: NotificationEventType; title: string; payload: unknown }): string {
  const { type } = input;
  const payload = asRecord(input.payload);
  switch (type) {
    case "fill": {
      const fill = asRecord(payload.fill);
      if (!fill) return input.title;
      const side = fill.side ? String(fill.side).toUpperCase() : "ORDER";
      const status = fill.status ? ` ${String(fill.status)}` : "";
      const quantity = fill.quantity != null ? ` ${fill.quantity}` : "";
      const symbol = fill.symbol ? ` ${fill.symbol}` : "";
      const notional = Number.isFinite(Number(fill.notional)) ? ` ($${Number(fill.notional).toFixed(2)})` : "";
      return `${side}${quantity}${symbol}${status}${notional}`.trim();
    }
    case "block": {
      const decision = asRecord(payload.decision);
      const rawReasons = Array.isArray(decision?.reasons) ? decision.reasons : payload.reason ? [payload.reason] : [];
      const reasons = rawReasons.map(String);
      return reasons.length > 0 ? reasons.join("\n") : input.title;
    }
    case "pending_approval": {
      const proposal = asRecord(payload.proposal);
      if (!proposal) return input.title;
      const side = proposal.side ? String(proposal.side).toUpperCase() : "ORDER";
      const symbol = proposal.symbol ? ` ${proposal.symbol}` : "";
      return `Approval needed for ${side}${symbol}`.trim();
    }
    case "kill_switch":
    case "run_failed":
      return String(payload.summary ?? input.title);
    case "limit_order_stale":
      return String(payload.summary ?? input.title);
    case "proposal_withdrawn":
      return String(payload.reason ?? input.title);
    case "budget_alert": {
      const provider = payload.provider ? String(payload.provider) : "provider";
      const operation = payload.operation ? String(payload.operation) : "usage check";
      const limitName = payload.limitName ? String(payload.limitName) : "usage limit";
      const unit = payload.unit ? ` ${String(payload.unit)}` : "";
      const used = Number.isFinite(Number(payload.used)) ? Number(payload.used).toLocaleString("en-US") : undefined;
      const limit = Number.isFinite(Number(payload.limit)) ? Number(payload.limit).toLocaleString("en-US") : undefined;
      const recommendation = payload.recommendation ? `\nAction: ${String(payload.recommendation)}` : "";
      const usage = used || limit ? `\nUsage: ${used ?? "unknown"}${unit}${limit ? ` of ${limit}${unit}` : ""}` : "";
      return `${provider} hit ${limitName} during ${operation}.${usage}${recommendation}`;
    }
    default:
      return input.title;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function formatDiscordPayload(input: {
  type: NotificationEventType;
  title: string;
  payload: any;
}) {
  const { type, title, payload } = input;
  let color = 10038562; // Default dark red
  let description = "";
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

  switch (type) {
    case "fill": {
      color = 3066993; // Green
      const fill = payload?.fill;
      if (fill) {
        fields.push(
          { name: "Symbol", value: String(fill.symbol), inline: true },
          { name: "Side", value: String(fill.side).toUpperCase(), inline: true },
          { name: "Status", value: String(fill.status), inline: true },
          { name: "Quantity", value: String(fill.quantity), inline: true },
          { name: "Price", value: `$${Number(fill.price).toFixed(2)}`, inline: true },
          { name: "Notional", value: `$${Number(fill.notional).toFixed(2)}`, inline: true }
        );
      }
      if (payload?.runId) {
        fields.push({ name: "Run ID", value: String(payload.runId), inline: false });
      }
      break;
    }
    case "block": {
      color = 15158332; // Red
      const reasons: string[] = payload?.decision?.reasons ?? (payload?.reason ? [payload.reason] : []);
      if (reasons.length > 0) {
        description = reasons.map(r => `• ${r}`).join("\n");
      } else {
        description = "No specific reasons provided.";
      }
      if (payload?.review?.estimatedNotional) {
        fields.push({ name: "Estimated Notional", value: `$${Number(payload.review.estimatedNotional).toFixed(2)}`, inline: true });
      }
      if (payload?.proposalId) {
        fields.push({ name: "Proposal ID", value: String(payload.proposalId), inline: true });
      }
      break;
    }
    case "pending_approval": {
      color = 15105570; // Orange
      const proposal = payload?.proposal;
      const review = payload?.review;
      if (proposal) {
        fields.push(
          { name: "Symbol", value: String(proposal.symbol), inline: true },
          { name: "Side", value: String(proposal.side).toUpperCase(), inline: true },
          { name: "Order Type", value: String(proposal.type), inline: true }
        );
        if (proposal.quantity) {
          fields.push({ name: "Quantity", value: String(proposal.quantity), inline: true });
        }
        if (proposal.dollarAmount) {
          fields.push({ name: "Dollar Amount", value: `$${Number(proposal.dollarAmount).toFixed(2)}`, inline: true });
        }
        if (review?.estimatedNotional) {
          fields.push({ name: "Estimated Notional", value: `$${Number(review.estimatedNotional).toFixed(2)}`, inline: true });
        }
        if (proposal.rationale) {
          description = `**Rationale:** ${proposal.rationale}`;
        }
      }
      if (payload?.proposalId) {
        fields.push({ name: "Proposal ID", value: String(payload.proposalId), inline: false });
      }
      break;
    }
    case "kill_switch": {
      color = 10181046; // Purple
      description = payload?.summary ?? "Kill switch triggered.";
      if (payload?.runId) {
        fields.push({ name: "Run ID", value: String(payload.runId), inline: false });
      }
      break;
    }
    case "price_alert": {
      color = 3447003; // Blue
      const alert = payload?.alert;
      const currentPrice = payload?.currentPrice;
      if (alert) {
        fields.push(
          { name: "Symbol", value: String(alert.symbol), inline: true },
          { name: "Rule", value: `${alert.op} $${Number(alert.price).toFixed(2)}`, inline: true },
          { name: "Triggered At", value: `$${Number(currentPrice ?? alert.triggeredPrice).toFixed(2)}`, inline: true }
        );
        if (alert.note) description = String(alert.note);
      }
      break;
    }
    case "run_failed": {
      color = 15158332; // Red
      description = payload?.summary ?? "Strategy run failed.";
      if (payload?.runId) {
        fields.push({ name: "Run ID", value: String(payload.runId), inline: false });
      }
      break;
    }
    case "proposal_withdrawn": {
      color = 15844367; // Amber — a pending idea was pulled, not an error
      const proposal = payload?.proposal;
      const expired = payload?.source === "expiry";
      if (proposal) {
        fields.push(
          { name: "Symbol", value: String(proposal.symbol), inline: true },
          { name: "Side", value: String(proposal.side).toUpperCase(), inline: true },
          { name: "Outcome", value: expired ? "Expired" : "Withdrawn", inline: true }
        );
      }
      if (payload?.reason) description = String(payload.reason);
      if (payload?.proposalId) {
        fields.push({ name: "Proposal ID", value: String(payload.proposalId), inline: false });
      }
      break;
    }
    case "limit_order_stale": {
      color = 15105570; // Orange
      const order = payload?.order;
      description = payload?.summary ?? "Limit order is still working after the configured threshold.";
      if (order) {
        fields.push(
          { name: "Symbol", value: String(order.symbol), inline: true },
          { name: "Side", value: String(order.side).toUpperCase(), inline: true },
          { name: "State", value: String(order.state), inline: true }
        );
        if (payload?.remainingQuantity !== undefined) {
          fields.push({ name: "Remaining", value: String(payload.remainingQuantity), inline: true });
        }
        if (payload?.ageMinutes !== undefined) {
          fields.push({ name: "Age", value: `${payload.ageMinutes} min`, inline: true });
        }
      }
      break;
    }
    case "budget_alert": {
      color = 15105570; // Orange
      description = payload?.recommendation ?? "A provider usage cap, quota, or budget threshold was reached.";
      fields.push(
        { name: "Provider", value: String(payload?.provider ?? "Unknown"), inline: true },
        { name: "Limit", value: String(payload?.limitName ?? "Usage limit"), inline: true },
        { name: "Operation", value: String(payload?.operation ?? "Unknown"), inline: true }
      );
      if (payload?.used !== undefined || payload?.limit !== undefined) {
        const unit = payload?.unit ? ` ${String(payload.unit)}` : "";
        fields.push({
          name: "Usage",
          value: `${payload?.used ?? "unknown"}${unit}${payload?.limit !== undefined ? ` / ${payload.limit}${unit}` : ""}`,
          inline: true
        });
      }
      if (payload?.skipped !== undefined) {
        fields.push({ name: "Skipped", value: String(payload.skipped), inline: true });
      }
      break;
    }
  }

  return {
    embeds: [
      {
        title,
        description: description || undefined,
        color,
        fields: fields.length > 0 ? fields : undefined,
        timestamp: new Date().toISOString()
      }
    ]
  };
}

function record(
  input: { type: NotificationEventType; title: string; payload: unknown },
  status: NotificationEvent["status"],
  webhookUrl?: string,
  error?: string,
  userId: string = "local",
  connectedAccountId?: string
): NotificationEvent {
  const event = insertNotificationEvent({
    userId,
    connectedAccountId,
    type: input.type,
    title: input.title,
    status,
    webhookUrl: webhookUrl ? maskWebhookUrl(webhookUrl) : undefined,
    payload: input.payload,
    error
  });
  audit("notification", event, userId, connectedAccountId);
  return event;
}

function maskWebhookUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    return url.toString();
  } catch {
    return value;
  }
}
