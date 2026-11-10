/** Delivery-ledger helpers for the Activity Notifications tab.
 *
 *  One notification_events row is one attempted send (possibly across several
 *  channels).  Channel is best-effort from the stored webhook URL / error — the
 *  per-channel result list lives on the `notification.delivery` audit row.
 */

import type { NotificationEvent } from "./types";

export type DeliveryChannelFilter = "all" | "push" | "email" | "sms" | "pushover" | "webhook";

export const DELIVERY_CHANNEL_FILTERS: ReadonlyArray<{ id: DeliveryChannelFilter; label: string }> = [
  { id: "all", label: "Every Channel" },
  { id: "push", label: "Push" },
  { id: "email", label: "Email" },
  { id: "sms", label: "SMS" },
  { id: "pushover", label: "Pushover" },
  { id: "webhook", label: "Webhook" }
];

export function deliveryChannelId(event: NotificationEvent): Exclude<DeliveryChannelFilter, "all"> {
  if (event.webhookUrl) return "webhook";
  const err = (event.error ?? "").toLowerCase();
  if (err.includes("pushover")) return "pushover";
  if (err.includes("twilio") || err.includes("sms") || err.includes("10dlc")) return "sms";
  if (err.includes("resend") || err.includes("email") || err.includes("@")) return "email";
  if (err.includes("ntfy") || err.includes("webhook")) return "webhook";
  return "push";
}

export function deliveryChannelLabel(event: NotificationEvent): string {
  switch (deliveryChannelId(event)) {
    case "email":
      return "Email";
    case "sms":
      return "SMS";
    case "pushover":
      return "Pushover";
    case "webhook":
      return "Webhook";
    default:
      return "Push";
  }
}

export function matchesDeliveryChannelFilter(
  event: NotificationEvent,
  filter: DeliveryChannelFilter
): boolean {
  if (filter === "all") return true;
  return deliveryChannelId(event) === filter;
}

/** Mask a destination so the ledger never shows a credential or full address. */
export function maskDeliveryDestination(raw?: string | null): string {
  if (!raw) return "";
  const value = raw.trim();
  if (!value) return "";
  if (value.includes("@")) {
    const [user, domain] = value.split("@");
    if (!domain) return value;
    const keep = user.slice(0, 1);
    return `${keep}…@${domain}`;
  }
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
