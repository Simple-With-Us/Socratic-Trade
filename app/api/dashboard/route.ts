import { getDashboardSnapshot } from "@/lib/dashboard";
import { coalesceUserDashboardSnapshot } from "@/lib/dashboard-coalesce";
import { buildDashboardConsent } from "@/lib/dashboard-consent";
import { auth } from "@/lib/auth/auth";
import { resolveRequestUserOrResponse } from "@/lib/request-user";
import { NextResponse } from "next/server";
import {
  DASHBOARD_SNAPSHOT_FIELDS,
  parseDashboardFields,
  sliceDashboardSnapshot
} from "../../dashboard-slice";
import type { DashboardSnapshot } from "../../dashboard-types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = resolveRequestUserOrResponse(request);
  if (user instanceof Response) return user;

  // W13 / ST-4689: optional `fields=a,b` slice.  Parsed before the snapshot compute so a
  // typo costs nothing; unknown names are a 400 (never a silently smaller payload).
  const selection = parseDashboardFields(new URL(request.url).searchParams.getAll("fields"));
  if (selection.unknown.length > 0) {
    return NextResponse.json(
      {
        error: `Unknown dashboard field${selection.unknown.length === 1 ? "" : "s"}: ${selection.unknown.join(", ")}`,
        allowed: DASHBOARD_SNAPSHOT_FIELDS
      },
      { status: 400 }
    );
  }

  const session = process.env.AUTH_SECRET ? await auth().catch(() => null) : null;
  const sessionWithProvider = session as (typeof session & { loginProvider?: unknown });
  const loginProvider = typeof sessionWithProvider?.loginProvider === "string"
    ? sessionWithProvider.loginProvider
    : undefined;
  // force-dynamic stays. The JSON body is the same snapshot as a direct read.
  // The coalescer is in-process only, so this response does not grow a shared max-age.
  const snapshot = await coalesceUserDashboardSnapshot(user.userId, () => getDashboardSnapshot(user.userId, {
    email: user.email ?? session?.user?.email ?? undefined,
    name: session?.user?.name ?? undefined,
    imageUrl: session?.user?.image ?? undefined,
    loginProvider
  }));
  // W15 / ST-4689: consent is merged AFTER the coalesced (possibly cached) read, so an
  // accept shows on the next poll instead of waiting out the snapshot TTL.  It overrides
  // any value a cached payload might already carry.  The cast marks the wire boundary:
  // getDashboardSnapshot's inferred type is the server's own shape, and DashboardSnapshot
  // is the contract the console reads (the route has always shipped it untyped).
  const withConsent = {
    ...snapshot,
    consent: buildDashboardConsent(user.userId)
  } as unknown as DashboardSnapshot;
  const body = selection.fields ? sliceDashboardSnapshot(withConsent, selection.fields) : withConsent;
  return NextResponse.json(body);
}
