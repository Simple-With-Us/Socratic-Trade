import { sendPolicyWebhookTest } from "@/lib/notifications";
import { resolveRequestUserId } from "@/lib/request-user";
import { notify } from "@/lib/notify";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { userId?: unknown };
  const userId = resolveRequestUserId(request, body);
  const notifyResults = await notify(userId, {
    title: "Test notification",
    body: "If you received this, your alert delivery channel is working.",
    kind: "test"
  });
  const results: Array<{ channel: string; ok: boolean; skipped?: string; error?: string }> = [...notifyResults];
  const legacyWebhook = await sendPolicyWebhookTest(userId);
  if (legacyWebhook) {
    results.push({ ...legacyWebhook, channel: "Policy webhook URL" });
  }
  return NextResponse.json({ results });
}
