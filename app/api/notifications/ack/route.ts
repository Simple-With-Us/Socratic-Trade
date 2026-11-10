import { invalidateDashboardSnapshotCache } from "@/lib/dashboard-snapshot-cache";
import { resolveRequestUserId } from "@/lib/request-user";
import { acknowledgeAllNotificationEvents, acknowledgeNotificationEvents } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Acknowledge notification_events rows for the Alert Center. Accepts either
 *  { ids: string[] } (specific rows) or { all: true, filter: "attention", connectedAccountId? }
 *  (bulk, scoped to the requesting user's current unacknowledged Attention-matching rows).
 *  connectedAccountId is optional and, when supplied, further scopes the bulk ack to that account
 *  (plus account-less rows) — it must match the account the Alert Center's "attention" list is
 *  actually rendering (see inScopeNotifications in app/console/components/alert-center.tsx), or
 *  "Acknowledge all" would silently ack alerts from a different account the user never saw. Always
 *  user-scoped via resolveRequestUserId — never trusts a client-supplied userId (mirrors
 *  app/api/notifications/route.ts). */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { ids?: unknown; all?: unknown; filter?: unknown; connectedAccountId?: unknown };
  const userId = resolveRequestUserId(request, body);

  if (body.all === true) {
    const filter = body.filter === "attention" ? "attention" : "attention";
    const connectedAccountId = typeof body.connectedAccountId === "string" && body.connectedAccountId.length > 0 ? body.connectedAccountId : undefined;
    const acknowledged = acknowledgeAllNotificationEvents(userId, filter, connectedAccountId);
    invalidateDashboardSnapshotCache(userId);
    return NextResponse.json({ acknowledged });
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  const acknowledged = acknowledgeNotificationEvents(userId, ids);
  invalidateDashboardSnapshotCache(userId);
  return NextResponse.json({ acknowledged });
}
