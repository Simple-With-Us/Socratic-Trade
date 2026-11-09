import { getDashboardSnapshot } from "@/lib/dashboard";
import { auth } from "@/lib/auth/auth";
import { resolveRequestUser } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = resolveRequestUser(request);
  const session = process.env.AUTH_SECRET ? await auth().catch(() => null) : null;
  const sessionWithProvider = session as (typeof session & { loginProvider?: unknown });
  const loginProvider = typeof sessionWithProvider?.loginProvider === "string"
    ? sessionWithProvider.loginProvider
    : undefined;
  return NextResponse.json(await getDashboardSnapshot(user.userId, {
    email: user.email ?? session?.user?.email ?? undefined,
    name: session?.user?.name ?? undefined,
    imageUrl: session?.user?.image ?? undefined,
    loginProvider
  }));
}
