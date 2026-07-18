import { audit, getNotifyPrefs, getPolicy, insertNotificationEvent, getDb, reserveOptionAlert, releaseOptionAlertReservation } from "./db";
import { notify, type NotifyDispatchDeps } from "./notify";
import type { NotificationEvent, NotificationEventType, NotifyChannelId, NotifyChannelResult, TradingPolicy, OptionPosition } from "./types";

type Fetcher = typeof fetch;
type NotifyDispatcher = typeof notify;
type NotificationDeliveryControl = Pick<NotifyDispatchDeps, "assertActive" | "signal">;

type SendNotificationOptions = {
  policy?: TradingPolicy;
  fetcher?: Fetcher;
  timeoutMs?: number;
  userId?: string;
  connectedAccountId?: string;
  /** Override the compact bridge body while keeping delivery inside the enabled-event gate. */
  directBody?: string;
  /** Injectable dispatcher/deps keep failure and caller-routing tests offline. */
  notifyImpl?: NotifyDispatcher;
  notifyDeps?: Parameters<NotifyDispatcher>[2];
  /** Extra operator-only lane (for example the configured fallback email), invoked after gating. */
  additionalDelivery?: (control?: NotificationDeliveryControl) => Promise<NotifyChannelResult[]>;
  /** Cooperative ownership fence for callers whose work may be superseded while delivery awaits. */
  assertActive?: () => void;
  /** Cancellation signal paired with assertActive for in-flight delivery and retry waits. */
  signal?: AbortSignal;
};

function assertNotificationActive(options: SendNotificationOptions): void {
  options.assertActive?.();
  if (options.notifyDeps?.assertActive !== options.assertActive) {
    options.notifyDeps?.assertActive?.();
  }
  for (const signal of [options.signal, options.notifyDeps?.signal]) {
    if (!signal?.aborted) continue;
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Notification delivery ownership was lost.");
  }
}

function combineNotificationSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) return undefined;
  if (active.length === 1 || typeof AbortSignal.any !== "function") return active[0];
  return AbortSignal.any(active);
}

function guardedNotifyDeps(
  deps: NotifyDispatchDeps | undefined,
  assertActive: (() => void) | undefined,
  signal: AbortSignal | undefined
): NotifyDispatchDeps {
  const nestedAssert = deps?.assertActive;
  const combinedAssert = assertActive || nestedAssert
    ? () => {
        assertActive?.();
        nestedAssert?.();
      }
    : undefined;
  const combinedSignal = combineNotificationSignals(signal, deps?.signal);
  return {
    ...deps,
    ...(combinedAssert ? { assertActive: combinedAssert } : {}),
    ...(combinedSignal ? { signal: combinedSignal } : {})
  };
}

function notificationDeliveryControl(options: SendNotificationOptions): NotificationDeliveryControl {
  const hasGuard = options.assertActive !== undefined || options.notifyDeps?.assertActive !== undefined;
  const signal = combineNotificationSignals(options.signal, options.notifyDeps?.signal);
  return {
    ...(hasGuard ? { assertActive: () => assertNotificationActive(options) } : {}),
    ...(signal ? { signal } : {})
  };
}

const CHANNEL_LABELS: Record<NotifyChannelId, string> = {
  push: "Phone push",
  webhook: "Webhook",
  email: "Email",
  sms: "SMS"
};

export const NO_NOTIFICATION_CHANNELS_REASON = "No notification channels enabled.";

// Types that emit their own in-app audit rows before calling sendNotification.
// Skip writing a second in-app notification_events row for them to avoid double-writing.
const DIRECT_NOTIFY_SKIP_SET: ReadonlySet<NotificationEventType> = new Set([
  "storage_warning"
]);

// The ntfy push channel (notify.ts's CHANNELS.push.send) carries the message TITLE as a raw HTTP
// header value. The Fetch/Headers spec requires header values to be ByteString (Latin-1, code
// points 0x00-0xFF) — anything outside that range throws `TypeError: Cannot convert argument to a
// ByteString` at send time. Observed in prod: alert titles built from provider-health strings that
// use an em dash (U+2014, code point 8212) silently dropped the push channel end-to-end (the throw
// was caught and recorded as a `notify.error` audit row, never surfaced to the user). Transliterate
// the common offenders to ASCII first (readable), then strip anything else outside Latin-1 rather
// than let the send throw.
//
// NOTE: notify.ts keeps its OWN copy of this (see its push channel) rather than importing this one,
// to avoid a notify.ts <-> notifications.ts import cycle (notifications.ts already imports `notify`
// from notify.ts). Keep the two in sync if the character set below changes.
const NON_LATIN1_TRANSLITERATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2012\u2013\u2014\u2015]/g, "-"], // figure/en/em/horizontal-bar dashes
  [/\u2026/g, "..."], // horizontal ellipsis
  [/[\u2192\u21D2\u27F6\u279D\u27A1]/g, "->"], // rightwards arrow variants
  [/[\u2190\u21D0\u27F5]/g, "<-"], // leftwards arrow variants
  [/[\u2018\u2019]/g, "'"], // curly single quotes
  [/[\u201C\u201D]/g, '"'] // curly double quotes
];

/** Make `text` safe to carry as a raw HTTP header value (e.g. the ntfy push channel's `title`
 *  header): transliterate common non-Latin-1 punctuation to its ASCII equivalent, then strip
 *  anything else outside Latin-1 (the U+0000-U+00FF ByteString range Headers requires).
 *  Pure/no-op on already-ASCII text. */
export function sanitizePushHeaderText(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of NON_LATIN1_TRANSLITERATIONS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/[^\u0000-\u00FF]/g, "");
}

export async function sendNotification(
  input: {
    type: NotificationEventType;
    title: string;
    payload: unknown;
  },
  options: SendNotificationOptions = {}
): Promise<NotificationEvent> {
  assertNotificationActive(options);
  const userId = options.userId ?? "local";
  const policy = options.policy ?? getPolicy(userId);
  const connectedAccountId = options.connectedAccountId ?? policy.connectedAccountId;
  assertNotificationActive(options);
  const settings = policy.notificationSettings;
  const webhookUrl = settings.webhookUrl?.trim();

  if (!settings.enabledEvents.includes(input.type)) {
    assertNotificationActive(options);
    return record(input, "skipped", webhookUrl, "Notification type is disabled.", userId, connectedAccountId);
  }

  const results: NotifyChannelResult[] = [];
  const bridgeErrors: string[] = [];
  try {
    assertNotificationActive(options);
    const directResults = await sendDirectNotification(input, userId, {
      skipWebhook: !!webhookUrl,
      directBody: options.directBody,
      notifyImpl: options.notifyImpl,
      notifyDeps: options.notifyDeps,
      assertActive: options.assertActive,
      signal: options.signal
    });
    assertNotificationActive(options);
    results.push(...directResults);
  } catch (error) {
    assertNotificationActive(options);
    bridgeErrors.push(recordBridgeError(input.type, userId, "direct", error, connectedAccountId));
  }

  if (options.additionalDelivery) {
    try {
      assertNotificationActive(options);
      const additionalResults = await options.additionalDelivery(notificationDeliveryControl(options));
      assertNotificationActive(options);
      results.push(...additionalResults);
    } catch (error) {
      assertNotificationActive(options);
      bridgeErrors.push(recordBridgeError(input.type, userId, "additional", error, connectedAccountId));
    }
  }

  if (webhookUrl) {
    assertNotificationActive(options);
    const legacyWebhookResult = await sendLegacyWebhook(
      input,
      webhookUrl,
      options.fetcher ?? fetch,
      options.timeoutMs ?? 5000,
      options.signal
    );
    assertNotificationActive(options);
    results.push(legacyWebhookResult);
    assertNotificationActive(options);
    audit(
      legacyWebhookResult.ok ? "notify.sent" : "notify.error",
      {
        userId,
        channel: "webhook",
        kind: input.type,
        source: "legacy_policy_webhook",
        ...(legacyWebhookResult.error ? { error: legacyWebhookResult.error, attempts: 1 } : {})
      },
      userId,
      connectedAccountId
    );
  }

  assertNotificationActive(options);
  const outcome = deriveDeliveryOutcome(results, bridgeErrors);
  assertNotificationActive(options);
  const event = record(input, outcome.status, webhookUrl, outcome.reason, userId, connectedAccountId);
  assertNotificationActive(options);
  audit(
    "notification.delivery",
    {
      notificationEventId: event.id,
      type: input.type,
      status: event.status,
      results,
      bridgeErrors
    },
    userId,
    connectedAccountId
  );
  return event;
}

async function sendLegacyWebhook(
  input: { type: NotificationEventType; title: string; payload: unknown },
  webhookUrl: string,
  fetcher: Fetcher,
  timeoutMs: number,
  callerSignal?: AbortSignal
): Promise<NotifyChannelResult> {
  const isDiscord = webhookUrl.includes("discord.com/api/webhooks") || webhookUrl.includes("discordapp.com/api/webhooks");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const payloadBody = isDiscord
      ? formatDiscordPayload(input)
      : {
          type: input.type,
          title: input.title,
          payload: input.payload,
          createdAt: new Date().toISOString()
        };
    const response = await fetcher(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payloadBody),
      signal: combineNotificationSignals(callerSignal, controller.signal)
    });
    if (!response.ok) {
      return { channel: "webhook", ok: false, error: `Webhook returned HTTP ${response.status}.` };
    }
    return { channel: "webhook", ok: true };
  } catch (error) {
    return { channel: "webhook", ok: false, error: error instanceof Error ? error.message : "Webhook request failed." };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendDirectNotification(
  input: { type: NotificationEventType; title: string; payload: unknown },
  userId: string,
  options: {
    skipWebhook?: boolean;
    directBody?: string;
    notifyImpl?: NotifyDispatcher;
    notifyDeps?: Parameters<NotifyDispatcher>[2];
    assertActive?: () => void;
    signal?: AbortSignal;
  } = {}
): Promise<NotifyChannelResult[]> {
  const basePrefs = options.notifyDeps?.prefs;
  const prefs = options.skipWebhook
    ? (() => {
        const current = basePrefs ?? getNotifyPrefs(userId);
        return { ...current, channels: current.channels.filter((channel) => channel !== "webhook") };
      })()
    : basePrefs;
  const deps = guardedNotifyDeps(options.notifyDeps, options.assertActive, options.signal);
  return (options.notifyImpl ?? notify)(
    userId,
    {
      title: input.title,
      body: options.directBody ?? directNotificationBody(input),
      kind: input.type,
      data: input.payload
    },
    { ...deps, ...(prefs ? { prefs } : {}) }
  );
}

function recordBridgeError(
  type: NotificationEventType,
  userId: string,
  source: "direct" | "additional",
  error: unknown,
  connectedAccountId?: string
): string {
  const message = error instanceof Error ? error.message : String(error);
  audit("notify.bridge.error", { userId, type, source, error: message }, userId, connectedAccountId);
  return `${source === "direct" ? "Delivery bridge" : "Additional delivery"}: ${message}`;
}

function deriveDeliveryOutcome(
  results: NotifyChannelResult[],
  bridgeErrors: string[]
): { status: NotificationEvent["status"]; reason?: string } {
  const anySent = results.some((result) => result.ok);
  const failures = results
    .filter((result) => !result.ok && !result.skipped)
    .map((result) => `${CHANNEL_LABELS[result.channel]}: ${result.error?.trim() || "Delivery failed."}`);
  const failureDetails = [...failures, ...bridgeErrors];

  if (anySent) {
    return {
      status: "sent",
      reason: failureDetails.length > 0 ? `Partial delivery failure: ${failureDetails.join(" | ")}` : undefined
    };
  }
  if (failureDetails.length > 0) {
    return { status: "failed", reason: failureDetails.join(" | ") };
  }

  const skippedReasons = results
    .filter((result) => result.skipped)
    .map((result) =>
      result.skipped === "not_configured"
        ? `${CHANNEL_LABELS[result.channel]} is not configured by the operator.`
        : `${CHANNEL_LABELS[result.channel]} has no delivery target.`
    );
  return {
    status: "skipped",
    reason: skippedReasons.length > 0 ? skippedReasons.join(" | ") : NO_NOTIFICATION_CHANNELS_REASON
  };
}

function directNotificationBody(input: { type: NotificationEventType; title: string; payload: unknown }): string {
  const { type } = input;
  const payload = asRecord(input.payload);
  switch (type) {
    case "fill": {
      const fill = asRecord(payload.fill);
      if (!fill) return input.title;
      const side = fill.side ? String(fill.side).toUpperCase() : "ORDER";
      const symbol = fill.symbol ? ` ${fill.symbol}` : "";
      // recordFillFromProposal (performance.ts) zeroes quantity/price/notional on a "pending_reconciliation"
      // receipt when the broker hasn't reported a fill price yet — that's a pre-confirmation placeholder,
      // not a real $0 fill. Rendering the zeros verbatim reads as "BUY 0 JPM pending_reconciliation ($0.00)".
      // Key off status + absence of a priced fill (not just quantity === 0, which can be legitimately 0 on a
      // dollar-sized order awaiting its broker price) so a genuinely zero-priced CONFIRMED fill (status
      // "filled"/"partially_filled") still renders normally below.
      if (isPlaceholderFillReceipt(fill)) {
        const estimate = estimatedFillNotional(fill);
        const est = estimate !== undefined ? ` (~$${estimate.toFixed(2)} est.)` : "";
        return `${side}${symbol} — order accepted by broker; fill not yet confirmed${est}`.trim();
      }
      const status = fill.status ? ` ${String(fill.status)}` : "";
      const quantity = fill.quantity != null ? ` ${fill.quantity}` : "";
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
    case "run_failed": {
      // Every run_failed emission site (strategy.ts, strategy-execution.ts) puts the actual broker
      // rejection/decline/uncertainty detail under payload.reason or payload.error, never
      // payload.summary — summary is only ever populated by the order-agnostic "Strategy run failed"
      // emitter. Falling straight through to the title (as this used to) duplicated the title as the
      // body, e.g. SMS "BAC order rejected by broker\nBAC order rejected by broker", silently
      // dropping the real reason. kill_switch sites split the same way: the scheduled-halt emitter
      // carries summary, while the circuit-breaker and volatility-brake halts carry only reason —
      // so this shared fallback chain surfaces the breaker/brake reason for those too instead of
      // repeating the title.
      const detail = payload.summary ?? payload.reason ?? payload.error;
      return String(detail ?? input.title);
    }
    case "limit_order_stale":
      return String(payload.summary ?? input.title);
    case "proposal_withdrawn":
      return String(payload.reason ?? input.title);
    case "learning_review":
      return String(payload.summary ?? input.title);
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

/** True when `fill` is a recordFillFromProposal pre-confirmation placeholder receipt (status
 *  "pending_reconciliation" with no priced fill yet) rather than a real, priced fill — see the
 *  "fill" case in directNotificationBody for why this can't key off quantity/notional alone. */
function isPlaceholderFillReceipt(fill: unknown): boolean {
  const record = asRecord(fill);
  const price = Number(record.price);
  const hasPricedFill = Number.isFinite(price) && price > 0;
  return record.status === "pending_reconciliation" && !hasPricedFill;
}

/** Best-effort pre-fill notional estimate for a placeholder receipt, read from the review/proposal
 *  that recordFillFromProposal stamps onto `fill.raw` — NEVER fabricated when neither is present. */
function estimatedFillNotional(fill: unknown): number | undefined {
  const raw = asRecord(asRecord(fill).raw);
  const reviewEstimate = Number(asRecord(raw.review).estimatedNotional);
  if (Number.isFinite(reviewEstimate) && reviewEstimate > 0) return reviewEstimate;
  const dollarAmount = Number(asRecord(raw.proposal).dollarAmount);
  if (Number.isFinite(dollarAmount) && dollarAmount > 0) return dollarAmount;
  return undefined;
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
          { name: "Side", value: String(fill.side).toUpperCase(), inline: true }
        );
        // See directNotificationBody's "fill" case for why a "pending_reconciliation" receipt with
        // no priced fill is a placeholder, not a real $0.00 fill — same guard, Discord embed fields.
        if (isPlaceholderFillReceipt(fill)) {
          const estimate = estimatedFillNotional(fill);
          fields.push(
            { name: "Status", value: "Order accepted by broker; fill not yet confirmed", inline: true },
            { name: "Notional", value: estimate !== undefined ? `~$${estimate.toFixed(2)} est.` : "Pending", inline: true }
          );
        } else {
          fields.push(
            { name: "Status", value: String(fill.status), inline: true },
            { name: "Quantity", value: String(fill.quantity), inline: true },
            { name: "Price", value: `$${Number(fill.price).toFixed(2)}`, inline: true },
            { name: "Notional", value: `$${Number(fill.notional).toFixed(2)}`, inline: true }
          );
        }
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
      // Same field split as directNotificationBody: the circuit-breaker and volatility-brake
      // halts carry only payload.reason, so Discord must fall back to it too or those two real
      // production alerts render the generic text while SMS shows the specific reason.
      description = payload?.summary ?? payload?.reason ?? "Kill switch triggered.";
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
      // Mirrors directNotificationBody's run_failed fallback chain — most emission sites carry the
      // real broker rejection/decline/uncertainty detail under payload.reason or payload.error, not
      // payload.summary (see that case for the full explanation).
      description = payload?.summary ?? payload?.reason ?? payload?.error ?? "Strategy run failed.";
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
  const isSkippedInApp = DIRECT_NOTIFY_SKIP_SET.has(input.type);
  const event: NotificationEvent = isSkippedInApp
    ? {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        type: input.type,
        title: input.title,
        status,
        webhookUrl: webhookUrl ? maskWebhookUrl(webhookUrl) : undefined,
        payload: input.payload,
        error,
        connectedAccountId
      }
    : insertNotificationEvent({
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

export async function checkAndDispatchOptionAlerts(
  userId: string,
  connectedAccountId: string,
  accountNumber: string,
  options: OptionPosition[],
  gateway: any
): Promise<void> {
  const db = getDb();
  // Only successfully-delivered events are tracked as sent; skipped or failed
  // events must not prevent future delivery when the user enables the alert type.
  const recentAlerts = db.prepare(
    `SELECT payload FROM notification_events
     WHERE user_id = ? AND type = 'option_alert' AND status = 'sent'
       AND COALESCE(connected_account_id, '') = ?`
  ).all(userId, connectedAccountId) as Array<{ payload: string }>;

  const sentAlerts = new Set<string>();
  for (const row of recentAlerts) {
    try {
      const payload = JSON.parse(row.payload);
      if (payload.symbol && payload.alertType) {
        sentAlerts.add(`${payload.symbol}:${payload.alertType}`);
      }
    } catch {}
  }

  // Deliver a single (symbol, alertType) alert AT MOST ONCE across concurrent snapshot builds.
  // The in-memory `sentAlerts` read above is a fast/historical dedupe (already-delivered alerts),
  // but it is read once at the top — two concurrent requests both see the alert as unsent and both
  // would deliver it. `reserveOptionAlert` closes that race with an atomic DB claim; only the winner
  // sends. If the send does not actually deliver (alert type disabled, or a webhook failure — status
  // != "sent"), the claim is released so the alert stays deliverable on a later cycle, matching the
  // historical "only status='sent' dedupes" behavior. On success the claim persists as the dedupe.
  const deliverAlert = async (
    symbol: string,
    alertType: string,
    input: { type: NotificationEventType; title: string; payload: unknown }
  ): Promise<void> => {
    const key = `${symbol}:${alertType}`;
    if (sentAlerts.has(key)) return;
    if (!reserveOptionAlert(userId, connectedAccountId, symbol, alertType)) return;
    let delivered = false;
    try {
      const event = await sendNotification(input, { userId, connectedAccountId });
      delivered = event.status === "sent";
    } finally {
      if (delivered) {
        sentAlerts.add(key);
      } else {
        releaseOptionAlertReservation(userId, connectedAccountId, symbol, alertType);
      }
    }
  };

  const optionsExpiringSoon = options.filter((p) => {
    if (!p.expirationDate) return false;
    const days = Math.ceil((new Date(p.expirationDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    return days >= 0 && days <= 3;
  });

  const underlyingPrices: Record<string, number> = {};
  if (optionsExpiringSoon.length > 0) {
    const underlyings = Array.from(new Set(optionsExpiringSoon.map((p) => p.underlyingSymbol)));
    try {
      const quotes = await gateway.getEquityQuotes(accountNumber, underlyings);
      for (const sym of underlyings) {
        if (quotes[sym]?.price) {
          underlyingPrices[sym] = quotes[sym].price;
        }
      }
    } catch (err) {
      console.warn("[OptionAlerts] failed to fetch underlying quotes:", err);
    }
  }

  for (const p of options) {
    const symbol = p.symbol;
    const qty = p.quantity;
    
    // 1. Assignment / first appearance alert
    {
      const detail = `New option position detected: ${qty > 0 ? "Long" : "Short"} ${Math.abs(qty)} contracts of ${symbol} at average cost $${p.averageCost}.`;
      await deliverAlert(symbol, "appearance", {
        type: "option_alert",
        title: `New Option: ${qty > 0 ? "Bought" : "Sold"} ${Math.abs(qty)}x ${symbol}`,
        payload: {
          symbol,
          underlyingSymbol: p.underlyingSymbol,
          expirationDate: p.expirationDate,
          optionType: p.optionType,
          strikePrice: p.strikePrice,
          quantity: qty,
          averageCost: p.averageCost,
          marketValue: p.marketValue,
          alertType: "appearance",
          detail
        }
      });
    }

    // 2. Expiry alert (<= 3 days)
    if (p.expirationDate) {
      const days = Math.ceil((new Date(p.expirationDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      if (days >= 0 && days <= 3) {
        const detail = `Option position ${symbol} expires in ${days} days (on ${p.expirationDate}).`;
        await deliverAlert(symbol, "expiry", {
          type: "option_alert",
          title: `Option Expiring: ${symbol} (${days}d remaining)`,
          payload: {
            symbol,
            underlyingSymbol: p.underlyingSymbol,
            expirationDate: p.expirationDate,
            optionType: p.optionType,
            strikePrice: p.strikePrice,
            quantity: qty,
            averageCost: p.averageCost,
            marketValue: p.marketValue,
            alertType: "expiry",
            daysRemaining: days,
            detail
          }
        });

        // 3. ITM-at-expiry status alert
        const underlyingPrice = underlyingPrices[p.underlyingSymbol];
        if (underlyingPrice !== undefined) {
          const isItm = p.optionType === "call"
            ? underlyingPrice > p.strikePrice
            : underlyingPrice < p.strikePrice;

          if (isItm) {
            const detail = `Option ${symbol} is In-the-Money at expiry. Underlying price is $${underlyingPrice}, strike is $${p.strikePrice}.`;
            await deliverAlert(symbol, "itm", {
              type: "option_alert",
              title: `Option ITM at Expiry: ${symbol}`,
              payload: {
                symbol,
                underlyingSymbol: p.underlyingSymbol,
                expirationDate: p.expirationDate,
                optionType: p.optionType,
                strikePrice: p.strikePrice,
                quantity: qty,
                averageCost: p.averageCost,
                marketValue: p.marketValue,
                alertType: "itm",
                underlyingPrice,
                detail
              }
            });
          }
        }
      }
    }
  }
}
