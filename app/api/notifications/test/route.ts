import { sendPolicyWebhookTest } from "@/lib/notifications";
import { resolveRequestUserIdOrResponse } from "@/lib/request-user";
import { notify } from "@/lib/notify";
import { NextResponse } from "next/server";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const userId = resolveRequestUserIdOrResponse(request);
  if (userId instanceof Response) return userId;
  const limited = enforceRateLimit(userId, "notifications/test", RATE_LIMITS.notificationTest);
  if (limited) return limited;
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
