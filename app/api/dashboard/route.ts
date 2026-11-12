import { getDashboardSnapshot } from "@/lib/dashboard";
import { coalesceUserDashboardSnapshot } from "@/lib/dashboard-coalesce";
import { auth } from "@/lib/auth/auth";
import { resolveRequestUserOrResponse } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = resolveRequestUserOrResponse(request);
  if (user instanceof Response) return user;
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
  return NextResponse.json(snapshot);
}
