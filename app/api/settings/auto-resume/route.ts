import { NextResponse } from "next/server";
import { getAutoResumeOnBoot, setAutoResumeOnBoot } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  return NextResponse.json({ autoResumeOnBoot: getAutoResumeOnBoot(userId) });
}

export async function POST(request: Request) {
  const userId = resolveRequestUserId(request);
  let enabled = false;
  try {
    const body = (await request.json()) as { enabled?: boolean };
    enabled = body?.enabled === true;
  } catch {
    /* default disabled */
  }
  setAutoResumeOnBoot(userId, enabled);
  return NextResponse.json({ autoResumeOnBoot: enabled });
}
