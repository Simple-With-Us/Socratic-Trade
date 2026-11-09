// push-deep-links.ts — the universal-link URL and collapse id carried by a native push.
//
// The iOS app opens https://socratictrade.com universal links, so a push's deep link is an
// ordinary app URL: tapping the notification routes in-app, and the same URL opened on the
// website lands on a real page. Every shape emitted here therefore points at a route that
// EXISTS in the web app (app/console/*) — a link that 404s on the web is a broken link in the app
// too.
//
// URL shapes (canonical — the iOS router matches on these paths):
//   pending_approval -> https://socratictrade.com/console/approvals?proposal=<proposalId>
//   fill             -> https://socratictrade.com/console/orders?symbol=<SYMBOL>
//   price_alert      -> https://socratictrade.com/console/watchlist?symbol=<SYMBOL>
//   run_failed       -> https://socratictrade.com/console/activity?tab=alerts
//   kill_switch      -> https://socratictrade.com/console/activity?tab=alerts
//   (anything else)  -> https://socratictrade.com/console/activity?tab=notifications
//
// CONTRACT WITH THE iOS ROUTER (ios/SocraticTrade/DeepLink.swift). Every URL emitted here must be
// one `DeepLink.destination(for:)` accepts, or the tap opens the app and lands nowhere. That parser
// requires https + host exactly `socratictrade.com` + a path of `/console/<screen>` with EXACTLY
// two segments — which is why the catch-all is `/console/activity` and NOT bare `/console`: the
// parser rejects a one-segment path, and Activity is also where the notification itself is listed
// (app/console/activity/page.tsx renders notification events), so it is the honest landing for an
// event with no more specific screen. The pairing is pinned by test/apns-deep-link-contract.test.ts
// against the table in ios/SocraticTradeTests/PushNotificationTests.swift — a new event type or a
// new URL shape fails that test rather than silently shipping a dead tap.
// The id/symbol query params are additive: a client that only routes on the PATH still lands on
// the right screen, and the same ids are repeated as top-level payload fields for a client that
// prefers structured routing over URL parsing.
//
// Collapse ids exist for the events that otherwise STACK noisily on the lock screen: a
// re-proposed approval, a repeating run failure, and a re-fired price alert. Fills deliberately
// get NO collapse id — two fills are two distinct events and neither may replace the other.

import type { NotificationEventType } from "./types";

/**
 * Canonical app origin for universal links.
 *
 * `PUSH_DEEP_LINK_ORIGIN` is the ONLY override, and setting it is a deliberate act: the iOS router
 * pins the host to exactly `socratictrade.com` (DeepLink.universalLinkHost), so pointing this at
 * any other origin — `www.`, a preview host, http — silently turns every push tap into a no-op on
 * the phone while the web links still look fine. It used to also inherit `NEXT_PUBLIC_APP_ORIGIN`,
 * which nothing else in the app reads; that made an unrelated env var able to break push routing
 * by accident, so it was dropped rather than left as a trap.
 */
export function pushLinkOrigin(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.PUSH_DEEP_LINK_ORIGIN ?? "https://socratictrade.com").trim();
  return raw.replace(/\/+$/, "") || "https://socratictrade.com";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Routing ids pulled out of a notification payload, repeated as top-level push data so a client
 *  can route without parsing the URL. */
export interface PushRoutingData {
  proposalId?: string;
  alertId?: string;
  symbol?: string;
  runId?: string;
}

export function pushRoutingData(kind: string, payload: unknown): PushRoutingData {
  const record = asRecord(payload);
  const proposal = asRecord(record.proposal);
  const fill = asRecord(record.fill);
  const alert = asRecord(record.alert);
  const symbol = str(record.symbol) ?? str(proposal.symbol) ?? str(fill.symbol) ?? str(alert.symbol);
  const data: PushRoutingData = {};
  const proposalId = str(record.proposalId) ?? str(proposal.id);
  if (proposalId) data.proposalId = proposalId;
  const alertId = str(alert.id) ?? (kind === "price_alert" ? str(record.alertId) : undefined);
  if (alertId) data.alertId = alertId;
  if (symbol) data.symbol = symbol.toUpperCase();
  const runId = str(record.runId);
  if (runId) data.runId = runId;
  return data;
}

/** The universal-link URL a push should open. Always returns a URL — never a dead end. */
export function pushDeepLink(kind: string, payload: unknown, origin: string = pushLinkOrigin()): string {
  const routing = pushRoutingData(kind, payload);
  const path = (() => {
    switch (kind as NotificationEventType) {
      case "pending_approval":
      case "proposal_withdrawn":
        return routing.proposalId
          ? `/console/approvals?proposal=${encodeURIComponent(routing.proposalId)}`
          : "/console/approvals";
      case "fill":
      case "limit_order_stale":
        return routing.symbol ? `/console/orders?symbol=${encodeURIComponent(routing.symbol)}` : "/console/orders";
      case "price_alert":
        return routing.symbol
          ? `/console/watchlist?symbol=${encodeURIComponent(routing.symbol)}`
          : "/console/watchlist";
      case "run_failed":
      case "kill_switch":
        return "/console/activity?tab=alerts";
      default:
        // Notifications tab, not bare `/console`: the iOS router only accepts a two-segment
        // console path.  Catch-all events have no more specific screen, so they land on the
        // delivery ledger.  Failed runs / kill switch go to Alerts Center above.
        return "/console/activity?tab=notifications";
    }
  })();
  return `${origin}${path}`;
}

/**
 * The APNs collapse id, or undefined when every occurrence of this event deserves its own
 * notification. Keyed by the SITUATION (symbol/side/alert), not the run, so the third re-proposal
 * of the same trade replaces the first two instead of stacking three identical alerts.
 */
export function pushCollapseId(kind: string, payload: unknown): string | undefined {
  const record = asRecord(payload);
  const routing = pushRoutingData(kind, payload);
  switch (kind as NotificationEventType) {
    case "pending_approval": {
      const side = str(asRecord(record.proposal).side)?.toLowerCase();
      const key = [routing.symbol, side].filter(Boolean).join("-");
      return key ? `approval-${key}` : "approval";
    }
    case "run_failed":
      return routing.symbol ? `run-failed-${routing.symbol}` : "run-failed";
    case "kill_switch":
      return "kill-switch";
    case "price_alert":
      return routing.alertId ? `price-alert-${routing.alertId}` : routing.symbol ? `price-alert-${routing.symbol}` : undefined;
    case "limit_order_stale":
      return routing.symbol ? `limit-stale-${routing.symbol}` : undefined;
    // "fill" is deliberately absent: two fills are two events, and collapsing them would hide one.
    default:
      return undefined;
  }
}
